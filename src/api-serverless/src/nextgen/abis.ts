import { goerli, mainnet, sepolia } from '@wagmi/chains';
import { env } from '../../../env';

export interface NextGenContract {
  [goerli.id]: string;
  [sepolia.id]: string;
  [mainnet.id]: string;
}

export function getNextGenChainId() {
  const chainId = env.getIntOrNull('NEXTGEN_CHAIN_ID');
  if (chainId !== null) {
    if (chainId == sepolia.id) {
      return sepolia.id;
    }
    if (chainId == goerli.id) {
      return goerli.id;
    }
  }
  return mainnet.id;
}

export const NEXTGEN_SET_COLLECTION_PHASES_SELECTOR = '0xb85f97a0';

export const NEXTGEN_ADMIN: NextGenContract = {
  [goerli.id]: '0x1bAe1D145Dd61fBBB62C85f8A6d7B6eDe0D150f5',
  [sepolia.id]: '0xdA8d7A00D222b223e6152B22fFe97cA1778E5f38',
  [mainnet.id]: '0x26ad9c64930bf5e057cb895a183436b30ad140f8'
};

export const NEXTGEN_CORE: NextGenContract = {
  [goerli.id]: '0x25a972f1bf3c816061ceaea59d2bb3fe4c130766',
  [sepolia.id]: '0x60671e59a349589Ad74bE6cd643003a0Abb38cC3',
  [mainnet.id]: '0x45882f9bc325E14FBb298a1Df930C43a874B83ae'
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
