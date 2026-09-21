import { createPublicClient, createWalletClient, defineChain, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { collectorAbi, curveAbi, erc20Abi, reserveAbi } from './abi.mjs';

/**
 * One keeper tick, the same loop as onchain/script/Keeper.s.sol: sweep the curve, claim the ledger, convert the
 * ETH into the pay token, then sweep the reserve's most underweight line, halving the tranche until the policy
 * accepts it. Every step is skipped when there is nothing to do, so an idle tick sends no transaction. Without
 * COLLECTOR, RESERVE and KEEPER_KEY the tick reports that it is waiting and exits cleanly.
 */
const BPS = 10_000n;
const env = (key, fallback) => process.env[key] ?? fallback;
const log = (...parts) => console.log(new Date().toISOString(), ...parts);

export const robinhood = defineChain({ id: 4663, name: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [env('RH_RPC_URL', 'https://rpc.mainnet.chain.robinhood.com')] } } });

export async function tick({ rpcUrl = env('RH_RPC_URL', 'https://rpc.mainnet.chain.robinhood.com'), collector = env('COLLECTOR', ''), reserve = env('RESERVE', ''), key = env('KEEPER_KEY', ''), minClaim = BigInt(env('MIN_CLAIM_WEI', '20000000000000000')), slippageBps = BigInt(env('SLIPPAGE_BPS', '100')), chainId = Number(env('CHAIN_ID', '4663')) } = {}) {
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
  const done = { swept: false, claimed: 0n, converted: 0n, line: null, received: 0n };

  const curve = await read(collector, collectorAbi, 'curve');
  if (curve !== '0x0000000000000000000000000000000000000000' && !(await read(curve, curveAbi, 'graduated')) && (await read(curve, curveAbi, 'creatorTaxBalance')) > 0n) {
    await send(collector, collectorAbi, 'sweepCurve', [0n]);
    done.swept = true; log('swept the curve');
  }
  let [ledger, held] = await read(collector, collectorAbi, 'pending');
  if (ledger >= minClaim) { await send(collector, collectorAbi, 'claim'); done.claimed = ledger; held += ledger; log('claimed', ledger.toString()); }
  if (held >= minClaim) {
    await send(collector, collectorAbi, 'convert', [1n]);
    done.converted = held; log('converted', held.toString(), 'wei of ETH into the pay token');
  }

  if (await read(reserve, reserveAbi, 'sweepsPaused')) { log('sweeps are paused'); return done; }
  const payToken = await read(reserve, reserveAbi, 'payToken');
  const payDecimals = BigInt(await read(reserve, reserveAbi, 'payDecimals'));
  const pay = await read(payToken, erc20Abi, 'balanceOf', [reserve]);
  if (pay === 0n) { log('nothing to sweep'); return done; }
  const count = Number(await read(reserve, reserveAbi, 'lineCount'));
  let best = 0, bestGap = -Infinity;
  const lines = [];
  for (let index = 0; index < count; index++) {
    const line = await read(reserve, reserveAbi, 'lines', [BigInt(index)]);
    lines.push(line);
    const gap = Number(line[3]) - Number(await read(reserve, reserveAbi, 'weightBps', [BigInt(index)]));
    if (gap > bestGap) { bestGap = gap; best = index; }
  }
  const [token, feed, pool, targetBps, payIsToken0] = lines[best];
  const sharePrice = await read(reserve, reserveAbi, 'poolSharePriceOf', [{ token, feed, pool, targetBps, payIsToken0 }]);
  const multiplier = await read(token, erc20Abi, 'uiMultiplier');
  const expectedOut = amount => ((amount * 10n ** 18n / 10n ** payDecimals) * 10n ** 18n / sharePrice) * 10n ** 18n / multiplier;
  let amount = pay;
  for (let attempt = 0; attempt < 5 && amount >= 10n ** payDecimals; attempt++) {
    const minOut = expectedOut(amount) * (BPS - slippageBps) / BPS;
    try {
      await send(reserve, reserveAbi, 'sweep', [BigInt(best), amount, minOut]);
      done.line = best; done.received = minOut; log('swept line', best, 'with', amount.toString(), 'of the pay token');
      return done;
    } catch (error) {
      log('tranche refused:', (error.shortMessage || error.message || '').split('\n')[0]);
      amount /= 2n;
    }
  }
  log('no tranche fitted the policy this tick');
  return done;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  tick().then(result => { log('tick done', JSON.stringify(result, (_, value) => typeof value === 'bigint' ? value.toString() : value)); }).catch(error => { console.error(new Date().toISOString(), 'tick failed:', error.shortMessage || error.message); process.exitCode = 1; });
}
