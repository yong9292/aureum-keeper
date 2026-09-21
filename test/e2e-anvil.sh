#!/usr/bin/env bash
# The Node keeper against an anvil fork of Robinhood Chain: deploy the reserve and collector, launch AUREUM on the
# real Pons factory, trade once after the snipe window, run one tick, and check that NVDA landed in the reserve.
# Fresh keys are generated every run; the anvil default accounts carry EIP-7702 delegation code on this chain and
# must not be used. Requires foundry and the keeper's node_modules.
set -euo pipefail
cd "$(dirname "$0")/../.."
RPC=${RH_RPC_URL:-https://rpc.mainnet.chain.robinhood.com}
PORT=${ANVIL_PORT:-8547}
LOG=${ANVIL_LOG:-/tmp/aureum-anvil.log}
anvil --fork-url "$RPC" --port "$PORT" --silent > "$LOG" 2>&1 &
ANVIL=$!
trap 'kill $ANVIL 2>/dev/null || true' EXIT
for i in $(seq 1 60); do cast chain-id --rpc-url "http://127.0.0.1:$PORT" > /dev/null 2>&1 && break; sleep 0.5; done
LOCAL="http://127.0.0.1:$PORT"
key() { cast wallet new --json | python3 -c "import sys,json;d=json.load(sys.stdin);d=d[0] if isinstance(d,list) else d;print(d['private_key'],d['address'])"; }
read -r DEPLOYER_KEY DEPLOYER < <(key); read -r KEEPER_KEY KEEPER < <(key); read -r BUYER_KEY BUYER < <(key)
for who in "$DEPLOYER" "$KEEPER" "$BUYER"; do
  [ "$(cast code "$who" --rpc-url "$LOCAL")" = "0x" ] || { echo "account $who carries code"; exit 1; }
  cast rpc anvil_setBalance "$who" 0x21E19E0C9BAB2400000 --rpc-url "$LOCAL" > /dev/null
done
cd onchain
OUT=$(KEEPER="$KEEPER" forge script script/ForkSetup.s.sol:ForkSetup --rpc-url "$LOCAL" --broadcast --private-key "$DEPLOYER_KEY" --slow 2>&1)
RESERVE=$(echo "$OUT" | awk '/RESERVE/{print $2}' | tail -1); COLLECTOR=$(echo "$OUT" | awk '/COLLECTOR/{print $2}' | tail -1); CURVE=$(echo "$OUT" | awk '/CURVE/{print $2}' | tail -1); TOKEN=$(echo "$OUT" | awk '/TOKEN/{print $2}' | tail -1)
[ -n "$RESERVE" ] && [ -n "$COLLECTOR" ] && [ -n "$CURVE" ] || { echo "$OUT" | tail -20; exit 1; }
echo "reserve $RESERVE collector $COLLECTOR token $TOKEN curve $CURVE"
SNIPE=$(cast call 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e "snipeTaxSeconds()(uint256)" --rpc-url "$LOCAL")
cast rpc evm_increaseTime "$((SNIPE + 5))" --rpc-url "$LOCAL" > /dev/null; cast rpc evm_mine --rpc-url "$LOCAL" > /dev/null
CURVE="$CURVE" forge script script/ForkSetup.s.sol:ForkBuy --rpc-url "$LOCAL" --broadcast --private-key "$BUYER_KEY" --slow 2>&1 | grep -E "creator tax|ONCHAIN EXECUTION|error" | head -3
cd ../keeper
NVDA=0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC
BEFORE=$(cast call $NVDA "balanceOf(address)(uint256)" "$RESERVE" --rpc-url "$LOCAL")
RH_RPC_URL="$LOCAL" CHAIN_ID=4663 COLLECTOR="$COLLECTOR" RESERVE="$RESERVE" KEEPER_KEY="$KEEPER_KEY" MIN_CLAIM_WEI=1000000000000000 node src/tick.mjs
echo "second tick, no new fees: it keeps laying the pay token along the lines"
RH_RPC_URL="$LOCAL" CHAIN_ID=4663 COLLECTOR="$COLLECTOR" RESERVE="$RESERVE" KEEPER_KEY="$KEEPER_KEY" MIN_CLAIM_WEI=1000000000000000 node src/tick.mjs
AFTER=$(cast call $NVDA "balanceOf(address)(uint256)" "$RESERVE" --rpc-url "$LOCAL")
echo "reserve ledger (sweeps, paid, last):   $(cast call "$RESERVE" "ledger()(uint256,uint256,uint256)" --rpc-url "$LOCAL" | tr '\n' ' ')"
echo "collector ledger (count, eth, usdg, last): $(cast call "$COLLECTOR" "ledger()(uint256,uint256,uint256,uint256)" --rpc-url "$LOCAL" | tr '\n' ' ')"
for T in 0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9 0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3; do echo "other line $T: $(cast call $T "balanceOf(address)(uint256)" "$RESERVE" --rpc-url "$LOCAL")"; done
USDG_LEFT=$(cast call 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 "balanceOf(address)(uint256)" "$RESERVE" --rpc-url "$LOCAL")
echo "NVDA before: $BEFORE"; echo "NVDA after:  $AFTER"; echo "USDG left:   $USDG_LEFT"
[ "${AFTER%% *}" != "0" ] && [ "${AFTER%% *}" != "${BEFORE%% *}" ] && echo "E2E OK: the keeper put NVDA in the reserve" || { echo "E2E FAILED"; exit 1; }
