import { goerli, mainnet } from '@wagmi/chains';

export interface NextGenContract {
  [goerli.id]: string;
  [mainnet.id]: string;
}

export function getNextGenChainId() {
  if (process.env.NEXTGEN_CHAIN_ID) {
    const chainId: number = parseInt(process.env.NEXTGEN_CHAIN_ID);
    if (chainId == goerli.id) {
      return goerli.id;
    }
  }
  return mainnet.id;
}

export const NEXTGEN_CHAIN_ID = getNextGenChainId();

export const NEXTGEN_SET_COLLECTION_PHASES_SELECTOR = '0xb85f97a0';

export const NEXTGEN_ADMIN: NextGenContract = {
  [goerli.id]: '0x1bAe1D145Dd61fBBB62C85f8A6d7B6eDe0D150f5',
  [mainnet.id]: '0x26ad9c64930bf5e057cb895a183436b30ad140f8'
};

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
