# Aureum keeper

Written for: whoever runs the automation after AUREUM launches. One tick, on a schedule, is the whole job.

## What a tick does

It follows `onchain/script/Keeper.s.sol`, in Node with viem so it can run as a Render cron job without Foundry, and goes one step further than that reference when it buys:

1. If the Pons curve has creator tax waiting that would lift the ledger to `MIN_CLAIM_WEI`, `collector.sweepCurve(0)` moves it into the venue's escrow ledger. Less than that is left alone, so dust costs no gas.
2. If the ledger holds at least `MIN_CLAIM_WEI`, `collector.claim()` takes it as ETH.
3. If the collector holds at least `MIN_CLAIM_WEI` of ETH, `collector.convert(minPayOut)` pays the team share and sells the rest for USDG into the reserve. The floor is the WETH pool's own price less `SLIPPAGE_BPS` and five more basis points for the pool's fee.
4. If the reserve holds USDG and sweeps are not paused, the lines are walked from the most underweight. Each is offered what would bring it to its target (never less than one USDG); an offer the policy refuses is halved up to five times, which costs nothing because refusals are caught in simulation, and a line that keeps refusing is skipped for the next one. At most `MAX_SWEEPS` buys land in one tick.

On the anvil run of 21 September, 0.5 ETH of volume produced a 0.0185 ETH claim, 0.0075 ETH (1.5% of volume) was converted into 19.98 USDG, and the first tick bought NVDA, AAPL and GOOGL at exactly their target weights with no refusals.

Every step is skipped when there is nothing to do, so an idle tick sends no transaction. With `COLLECTOR`, `RESERVE` or `KEEPER_KEY` unset the tick logs `waiting` and exits with code 0.

## Running it

```sh
cd keeper && npm install
RH_RPC_URL=https://rpc.mainnet.chain.robinhood.com COLLECTOR=0x… RESERVE=0x… KEEPER_KEY=0x… npm run tick
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `RH_RPC_URL` | public node | JSON-RPC endpoint; the public node throttles shared egress, a dedicated provider is better for a cron |
| `COLLECTOR`, `RESERVE` | none | the deployed contracts; the tick waits without them |
| `KEEPER_KEY` | none | the keeper's private key; it can only sweep, claim, convert and sweep lines, never withdraw |
| `MIN_CLAIM_WEI` | 0.003 ETH | ledgers and balances below this wait for the next tick; the curve is not swept for less either |
| `MAX_SWEEPS` | 4 | buys per tick, most underweight line first, each sized to bring its line to target |
| `SLIPPAGE_BPS` | 100 | `minOut` under the pool's spot price for a line sweep |
| `CHAIN_ID` | 4663 | override for a local fork |

## Render

`render.yaml` at the repository root declares a cron job (`aureum-keeper`, every ten minutes, rootDir `keeper`, plan `starter`, region oregon). Validate with `render blueprints validate render.yaml`; it passes once Render's GitHub app can see the repository `yong9292/aureum-financial` on `main`. `KEEPER_KEY` is `sync: false`: typed into the dashboard, never committed.

## Proving it end to end

`test/e2e-anvil.sh` forks Robinhood Chain with anvil, generates fresh keys (the anvil defaults carry delegation code on this chain), deploys the reserve and collector, launches AUREUM on the real Pons factory with the collector as fee recipient, advances past the snipe window, buys 0.5 ETH, runs one tick and checks that NVDA arrived in the reserve. On 21 September 2026: swept, claimed 0.0185 ETH, converted, three tranches refused by the policy, then 4.11 USDG swept into 0.0184 NVDA.

```sh
bash keeper/test/e2e-anvil.sh
```
