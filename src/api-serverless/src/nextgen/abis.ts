export const NEXTGEN_CHAIN_ID = 5;

export const NEXTGEN_FUNCTION_SELECTOR = '0xb85f97a0';

const ADDRESS_INPUT = { internalType: 'address', name: '', type: 'address' };

const OUTPUT = {
  outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
  stateMutability: 'view',
  type: 'function'
};

export const NEXTGEN_ADMIN_ABI = [
  {
    inputs: [
      ADDRESS_INPUT,
      { internalType: 'uint256', name: '_collectionID', type: 'uint256' }
    ],
    name: 'retrieveCollectionAdmin',
    ...OUTPUT
  },
  {
    inputs: [
      ADDRESS_INPUT,
      { internalType: 'bytes4', name: '_selector', type: 'bytes4' }
    ],
    name: 'retrieveFunctionAdmin',
    ...OUTPUT
  },
  {
    inputs: [ADDRESS_INPUT],
    name: 'retrieveGlobalAdmin',
    ...OUTPUT
  }
];
