// export const DELEGATION_CONTRACT: {
//   chain_id: number;
//   contract: `0x${string}`;
// } = {
//   chain_id: 11155111,
//   contract: '0x8f86c644f845a077999939c69bc787662377d915'
// };
export const DELEGATION_CONTRACT: {
  chain_id: number;
  contract: `0x${string}`;
} = {
  chain_id: 1,
  contract: '0x2202CB9c00487e7e8EF21e6d8E914B32e709f43d'
};
// Block of the mainnet contract's creation transaction
// (0x5c5e8d06ed3de487a2f4c1b994b00e099a4c4ce1efb0521856dc571a66953f75).
// It has no logs before this block.
export const DELEGATION_CONTRACT_DEPLOYMENT_BLOCK = 17_114_433;
export const DELEGATION_ALL_ADDRESS =
  '0x8888888888888888888888888888888888888888';

export const USE_CASE_ALL = 1;
export const USE_CASE_MINTING = 2;
export const USE_CASE_AIRDROPS = 3;
export const USE_CASE_PRIMARY_ADDRESS = 997;
export const USE_CASE_SUB_DELEGATION = 998;
export const USE_CASE_CONSOLIDATION = 999;
