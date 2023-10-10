export const NEXTGEN_CHAIN_ID = 5;

export const NEXTGEN_FUNCTION_SELECTOR = '0xb85f97a0';

export const NEXTGEN_ADMIN_ABI = [
  { inputs: [], stateMutability: 'nonpayable', type: 'constructor' },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'address',
        name: 'previousOwner',
        type: 'address'
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'newOwner',
        type: 'address'
      }
    ],
    name: 'OwnershipTransferred',
    type: 'event'
  },
  {
    inputs: [{ internalType: 'address', name: '', type: 'address' }],
    name: 'adminPermissions',
    outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function'
  },
  {
    inputs: [],
    name: 'isAdminContract',
    outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function'
  },
  {
    inputs: [],
    name: 'owner',
    outputs: [{ internalType: 'address', name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function'
  },
  {
    inputs: [
      { internalType: 'address', name: '_admin', type: 'address' },
      { internalType: 'bool', name: '_status', type: 'bool' }
    ],
    name: 'registerAdmin',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function'
  },
  {
    inputs: [
      { internalType: 'address', name: '_address', type: 'address' },
      { internalType: 'bytes4[]', name: '_selector', type: 'bytes4[]' },
      { internalType: 'bool', name: '_status', type: 'bool' }
    ],
    name: 'registerBatchFunctionAdmin',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function'
  },
  {
    inputs: [
      { internalType: 'uint256', name: '_collectionID', type: 'uint256' },
      { internalType: 'address', name: '_address', type: 'address' },
      { internalType: 'bool', name: '_status', type: 'bool' }
    ],
    name: 'registerCollectionAdmin',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function'
  },
  {
    inputs: [
      { internalType: 'address', name: '_address', type: 'address' },
      { internalType: 'bytes4', name: '_selector', type: 'bytes4' },
      { internalType: 'bool', name: '_status', type: 'bool' }
    ],
    name: 'registerFunctionAdmin',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function'
  },
  {
    inputs: [],
    name: 'renounceOwnership',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function'
  },
  {
    inputs: [
      { internalType: 'address', name: '_address', type: 'address' },
      { internalType: 'uint256', name: '_collectionID', type: 'uint256' }
    ],
    name: 'retrieveCollectionAdmin',
    outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function'
  },
  {
    inputs: [
      { internalType: 'address', name: '_address', type: 'address' },
      { internalType: 'bytes4', name: '_selector', type: 'bytes4' }
    ],
    name: 'retrieveFunctionAdmin',
    outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function'
  },
  {
    inputs: [{ internalType: 'address', name: '_address', type: 'address' }],
    name: 'retrieveGlobalAdmin',
    outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function'
  },
  {
    inputs: [{ internalType: 'address', name: 'newOwner', type: 'address' }],
    name: 'transferOwnership',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function'
  }
];
