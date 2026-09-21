export const collectorAbi = [
  { type: 'function', name: 'curve', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'pending', stateMutability: 'view', inputs: [], outputs: [{ name: 'ledger', type: 'uint256' }, { name: 'held', type: 'uint256' }] },
  { type: 'function', name: 'sweepCurve', stateMutability: 'nonpayable', inputs: [{ name: 'minBuybackTokensOut', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'claim', stateMutability: 'nonpayable', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'convert', stateMutability: 'nonpayable', inputs: [{ name: 'minPayOut', type: 'uint256' }], outputs: [{ type: 'uint256' }] },
];
export const curveAbi = [
  { type: 'function', name: 'graduated', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'creatorTaxBalance', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
];
export const reserveAbi = [
  { type: 'function', name: 'payToken', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'payDecimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'lineCount', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'lines', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ name: 'token', type: 'address' }, { name: 'feed', type: 'address' }, { name: 'pool', type: 'address' }, { name: 'targetBps', type: 'uint16' }, { name: 'payIsToken0', type: 'bool' }] },
  { type: 'function', name: 'weightBps', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'sweepsPaused', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'poolSharePriceOf', stateMutability: 'view', inputs: [{ name: 'line', type: 'tuple', components: [{ name: 'token', type: 'address' }, { name: 'feed', type: 'address' }, { name: 'pool', type: 'address' }, { name: 'targetBps', type: 'uint16' }, { name: 'payIsToken0', type: 'bool' }] }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'sweep', stateMutability: 'nonpayable', inputs: [{ name: 'index', type: 'uint256' }, { name: 'amountIn', type: 'uint256' }, { name: 'minOut', type: 'uint256' }], outputs: [{ type: 'uint256' }] },
];
export const erc20Abi = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'uiMultiplier', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
];
