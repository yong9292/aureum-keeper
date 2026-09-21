import { createPublicClient, createWalletClient, defineChain, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { collectorAbi, curveAbi, erc20Abi, poolAbi, reserveAbi } from './abi.mjs';

/**
 * One keeper tick. It follows onchain/script/Keeper.s.sol (sweep the curve, claim the ledger, convert the ETH
 * into the pay token, sweep the reserve) and goes one step further than that reference: instead of one line it
 * walks the lines from the most underweight, up to MAX_SWEEPS buys a tick, so small fees become holdings
 * across the basket within minutes. Fees are claimed once MIN_CLAIM_WEI has gathered (0.003 ETH by default). Every step is skipped when there is nothing to do, so an idle tick sends no transaction. Without
 * COLLECTOR, RESERVE and KEEPER_KEY the tick reports that it is waiting and exits cleanly.
 */
const BPS = 10_000n;
const env = (key, fallback) => process.env[key] ?? fallback;
const log = (...parts) => console.log(new Date().toISOString(), ...parts);

export const robinhood = defineChain({ id: 4663, name: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [env('RH_RPC_URL', 'https://rpc.mainnet.chain.robinhood.com')] } } });

export async function tick({ rpcUrl = env('RH_RPC_URL', 'https://rpc.mainnet.chain.robinhood.com'), collector = env('COLLECTOR', ''), reserve = env('RESERVE', ''), key = env('KEEPER_KEY', ''), minClaim = BigInt(env('MIN_CLAIM_WEI', '3000000000000000')), maxSweeps = Number(env('MAX_SWEEPS', '4')), slippageBps = BigInt(env('SLIPPAGE_BPS', '100')), chainId = Number(env('CHAIN_ID', '4663')) } = {}) {
  if (!collector || !reserve || !key) { log('waiting: COLLECTOR, RESERVE and KEEPER_KEY must all be set'); return { waiting: true }; }
  const chain = { ...robinhood, id: chainId, rpcUrls: { default: { http: [rpcUrl] } } };
  const transport = http(rpcUrl, { fetchOptions: { headers: { 'user-agent': 'Mozilla/5.0 aureum-keeper' } } });
  const account = privateKeyToAccount(key);
  const client = createPublicClient({ chain, transport });
  const wallet = createWalletClient({ chain, transport, account });
  const read = (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args });
  const send = async (address, abi, functionName, args = []) => {
    const { request } = await client.simulateContract({ address, abi, functionName, args, account });
    const hash = await wallet.writeContract(request);
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`${functionName} reverted in ${hash}`);
    return hash;
  };
  const done = { swept: false, claimed: 0n, converted: 0n, line: null, received: 0n, sweeps: [] };

  const curve = await read(collector, collectorAbi, 'curve');
  let [ledger, held] = await read(collector, collectorAbi, 'pending');
  // The curve is swept only when what it holds would lift the ledger past the claim mark, so dust costs no gas.
  const onCurve = curve !== '0x0000000000000000000000000000000000000000' && !(await read(curve, curveAbi, 'graduated')) ? await read(curve, curveAbi, 'creatorTaxBalance') : 0n;
  if (onCurve > 0n && onCurve + ledger >= minClaim) {
    await send(collector, collectorAbi, 'sweepCurve', [0n]);
    done.swept = true; log('swept the curve');
    [ledger, held] = await read(collector, collectorAbi, 'pending');
  }
  if (ledger >= minClaim) { await send(collector, collectorAbi, 'claim'); done.claimed = ledger; held += ledger; log('claimed', ledger.toString()); }
  if (held >= minClaim) {
    // The floor for the conversion is the WETH pool's own price less the slippage allowance and the pool's fee.
    const pool = await read(collector, collectorAbi, 'pool');
    const [sqrtPriceX96] = await read(pool, poolAbi, 'slot0');
    const shared = BigInt(await read(collector, collectorAbi, 'liquidityBps')) + BigInt(await read(collector, collectorAbi, 'operationsBps'));
    const ethIn = held - held * shared / BPS;
    const square = sqrtPriceX96 * sqrtPriceX96;
    const expected = (await read(collector, collectorAbi, 'wethIsToken0')) ? ethIn * square / (1n << 192n) : ethIn * (1n << 192n) / square;
    const minPayOut = expected * (BPS - slippageBps - 5n) / BPS;
    await send(collector, collectorAbi, 'convert', [minPayOut > 0n ? minPayOut : 1n]);
    done.converted = held; log('converted', ethIn.toString(), 'wei of ETH into the pay token, floor', minPayOut.toString());
  }

  if (await read(reserve, reserveAbi, 'sweepsPaused')) { log('sweeps are paused'); return done; }
  const payToken = await read(reserve, reserveAbi, 'payToken');
  const payDecimals = BigInt(await read(reserve, reserveAbi, 'payDecimals'));
  const pay = await read(payToken, erc20Abi, 'balanceOf', [reserve]);
  if (pay === 0n) { log('nothing to sweep'); return done; }
  const count = Number(await read(reserve, reserveAbi, 'lineCount'));
  const nav = await read(reserve, reserveAbi, 'nav');
  const unit = 10n ** payDecimals;
  const lines = [];
  for (let index = 0; index < count; index++) {
    const line = await read(reserve, reserveAbi, 'lines', [BigInt(index)]);
    const gap = BigInt(line[3]) - (await read(reserve, reserveAbi, 'weightBps', [BigInt(index)]));
    lines.push({ index, line, gap });
  }
  // Furthest below target first. Each line is offered what would bring it to target, never less than one unit of
  // the pay token; a refusal costs nothing (it is simulated) and halves the offer, and a line that keeps refusing
  // is left for the next one, so one thin pool cannot hold up the others.
  lines.sort((a, b) => (a.gap === b.gap ? a.index - b.index : a.gap > b.gap ? -1 : 1));
  let remaining = pay;
  for (const { index, line, gap } of lines) {
    if (done.sweeps.length >= maxSweeps || remaining < unit || gap <= 0n) break;
    const [token, feed, pool, targetBps, payIsToken0] = line;
    const sharePrice = await read(reserve, reserveAbi, 'poolSharePriceOf', [{ token, feed, pool, targetBps, payIsToken0 }]);
    const multiplier = await read(token, erc20Abi, 'uiMultiplier');
    const expectedOut = amount => ((amount * 10n ** 18n / unit) * 10n ** 18n / sharePrice) * 10n ** 18n / multiplier;
    const toTarget = nav * gap / BPS * unit / 10n ** 18n;
    let amount = toTarget > remaining ? remaining : toTarget < unit ? unit : toTarget;
    for (let attempt = 0; attempt < 5 && amount >= unit; attempt++) {
      const minOut = expectedOut(amount) * (BPS - slippageBps) / BPS;
      try {
        await send(reserve, reserveAbi, 'sweep', [BigInt(index), amount, minOut]);
        done.sweeps.push({ line: index, paid: amount });
        done.line = index; done.received = minOut; remaining -= amount;
        log('swept line', index, 'with', amount.toString(), 'of the pay token');
        break;
      } catch (error) {
        log('line', index, 'tranche refused:', (error.shortMessage || error.message || '').split('\n')[0]);
        amount /= 2n;
      }
    }
  }
  if (!done.sweeps.length) log('no tranche fitted the policy this tick');
  return done;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  tick().then(result => { log('tick done', JSON.stringify(result, (_, value) => typeof value === 'bigint' ? value.toString() : value)); }).catch(error => { console.error(new Date().toISOString(), 'tick failed:', error.shortMessage || error.message); process.exitCode = 1; });
}
