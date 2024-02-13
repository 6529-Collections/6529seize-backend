import { ethers } from 'ethers';

export const NFT_HISTORY_IFACE = new ethers.utils.Interface([
  {
    inputs: [
      { internalType: 'address[]', name: 'to', type: 'address[]' },
      { internalType: 'uint256[]', name: 'amounts', type: 'uint256[]' },
      { internalType: 'string[]', name: 'uris', type: 'string[]' }
    ],
    name: 'mintBaseNew',
    outputs: [{ internalType: 'uint256[]', name: '', type: 'uint256[]' }],
    stateMutability: 'nonpayable',
    type: 'function'
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'address',
        name: 'operator',
        type: 'address'
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'from',
        type: 'address'
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'to',
        type: 'address'
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'id',
        type: 'uint256'
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'value',
        type: 'uint256'
      }
    ],
    name: 'TransferSingle',
    type: 'event'
  },
  {
    inputs: [
      { internalType: 'uint256', name: 'tokenId', type: 'uint256' },
      { internalType: 'string', name: 'uri_', type: 'string' }
    ],
    name: 'setTokenURI',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function'
  },
  {
    inputs: [
      {
        internalType: 'address',
        name: 'creatorContractAddress',
        type: 'address'
      },
      {
        internalType: 'uint256',
        name: 'claimIndex',
        type: 'uint256'
      },
      {
        components: [
          {
            internalType: 'uint32',
            name: 'totalMax',
            type: 'uint32'
          },
          {
            internalType: 'uint32',
            name: 'walletMax',
            type: 'uint32'
          },
          {
            internalType: 'uint48',
            name: 'startDate',
            type: 'uint48'
          },
          {
            internalType: 'uint48',
            name: 'endDate',
            type: 'uint48'
          },
          {
            internalType: 'enum IERC1155LazyPayableClaim.StorageProtocol',
            name: 'storageProtocol',
            type: 'uint8'
          },
          {
            internalType: 'bytes32',
            name: 'merkleRoot',
            type: 'bytes32'
          },
          {
            internalType: 'string',
            name: 'location',
            type: 'string'
          },
          {
            internalType: 'uint256',
            name: 'cost',
            type: 'uint256'
          },
          {
            internalType: 'address payable',
            name: 'paymentReceiver',
            type: 'address'
          }
        ],
        internalType: 'struct IERC1155LazyPayableClaim.ClaimParameters',
        name: 'claimParameters',
        type: 'tuple'
      }
    ],
    name: 'initializeClaim',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function'
  },
  {
    inputs: [
      {
        internalType: 'address',
        name: 'creatorContractAddress',
        type: 'address'
      },
      {
        internalType: 'uint256',
        name: 'claimIndex',
        type: 'uint256'
      },
      {
        internalType: 'address[]',
        name: 'recipients',
        type: 'address[]'
      },
      {
        internalType: 'uint256[]',
        name: 'amounts',
        type: 'uint256[]'
      }
    ],
    name: 'airdrop',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function'
  },
  {
    inputs: [
      {
        internalType: 'address',
        name: 'creatorContractAddress',
        type: 'address'
      },
      {
        internalType: 'uint256',
        name: 'index',
        type: 'uint256'
      },
      {
        components: [
          {
            internalType: 'address payable',
            name: 'paymentReceiver',
            type: 'address'
          },
          {
            internalType: 'enum IBurnRedeemCore.StorageProtocol',
            name: 'storageProtocol',
            type: 'uint8'
          },
          {
            internalType: 'uint16',
            name: 'redeemAmount',
            type: 'uint16'
          },
          {
            internalType: 'uint32',
            name: 'totalSupply',
            type: 'uint32'
          },
          {
            internalType: 'uint48',
            name: 'startDate',
            type: 'uint48'
          },
          {
            internalType: 'uint48',
            name: 'endDate',
            type: 'uint48'
          },
          {
            internalType: 'uint160',
            name: 'cost',
            type: 'uint160'
          },
          {
            internalType: 'string',
            name: 'location',
            type: 'string'
          },
          {
            components: [
              {
                internalType: 'uint256',
                name: 'requiredCount',
                type: 'uint256'
              },
              {
                components: [
                  {
                    internalType: 'enum IBurnRedeemCore.ValidationType',
                    name: 'validationType',
                    type: 'uint8'
                  },
                  {
                    internalType: 'address',
                    name: 'contractAddress',
                    type: 'address'
                  },
                  {
                    internalType: 'enum IBurnRedeemCore.TokenSpec',
                    name: 'tokenSpec',
                    type: 'uint8'
                  },
                  {
                    internalType: 'enum IBurnRedeemCore.BurnSpec',
                    name: 'burnSpec',
                    type: 'uint8'
                  },
                  {
                    internalType: 'uint72',
                    name: 'amount',
                    type: 'uint72'
                  },
                  {
                    internalType: 'uint256',
                    name: 'minTokenId',
                    type: 'uint256'
                  },
                  {
                    internalType: 'uint256',
                    name: 'maxTokenId',
                    type: 'uint256'
                  },
                  {
                    internalType: 'bytes32',
                    name: 'merkleRoot',
                    type: 'bytes32'
                  }
                ],
                internalType: 'struct IBurnRedeemCore.BurnItem[]',
                name: 'items',
                type: 'tuple[]'
              }
            ],
            internalType: 'struct IBurnRedeemCore.BurnGroup[]',
            name: 'burnSet',
            type: 'tuple[]'
          }
        ],
        internalType: 'struct IBurnRedeemCore.BurnRedeemParameters',
        name: 'burnRedeemParameters',
        type: 'tuple'
      }
    ],
    name: 'initializeBurnRedeem',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function'
  },
  {
    inputs: [
      {
        internalType: 'address',
        name: 'creatorContractAddress',
        type: 'address'
      },
      {
        internalType: 'uint256',
        name: 'claimIndex',
        type: 'uint256'
      },
      {
        components: [
          {
            internalType: 'uint32',
            name: 'totalMax',
            type: 'uint32'
          },
          {
            internalType: 'uint32',
            name: 'walletMax',
            type: 'uint32'
          },
          {
            internalType: 'uint48',
            name: 'startDate',
            type: 'uint48'
          },
          {
            internalType: 'uint48',
            name: 'endDate',
            type: 'uint48'
          },
          {
            internalType: 'enum ILazyPayableClaim.StorageProtocol',
            name: 'storageProtocol',
            type: 'uint8'
          },
          {
            internalType: 'bytes32',
            name: 'merkleRoot',
            type: 'bytes32'
          },
          {
            internalType: 'string',
            name: 'location',
            type: 'string'
          },
          {
            internalType: 'uint256',
            name: 'cost',
            type: 'uint256'
          },
          {
            internalType: 'address payable',
            name: 'paymentReceiver',
            type: 'address'
          },
          {
            internalType: 'address',
            name: 'erc20',
            type: 'address'
          }
        ],
        internalType: 'struct IERC1155LazyPayableClaim.ClaimParameters',
        name: 'claimParameters',
        type: 'tuple'
      }
    ],
    name: 'initializeClaim',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function'
  },
  {
    inputs: [
      {
        internalType: 'address',
        name: 'creatorContractAddress',
        type: 'address'
      },
      {
        internalType: 'uint256',
        name: 'claimIndex',
        type: 'uint256'
      },
      {
        internalType: 'uint32',
        name: 'mintIndex',
        type: 'uint32'
      },
      {
        internalType: 'bytes32[]',
        name: 'merkleProof',
        type: 'bytes32[]'
      },
      {
        internalType: 'address',
        name: 'mintFor',
        type: 'address'
      }
    ],
    name: 'mint',
    outputs: [],
    stateMutability: 'payable',
    type: 'function'
  },
  {
    inputs: [
      {
        internalType: 'address',
        name: 'creatorContractAddress',
        type: 'address'
      },
      {
        internalType: 'uint256',
        name: 'claimIndex',
        type: 'uint256'
      },
      {
        internalType: 'uint16',
        name: 'mintCount',
        type: 'uint16'
      },
      {
        internalType: 'uint32[]',
        name: 'mintIndices',
        type: 'uint32[]'
      },
      {
        internalType: 'bytes32[][]',
        name: 'merkleProofs',
        type: 'bytes32[][]'
      },
      {
        internalType: 'address',
        name: 'mintFor',
        type: 'address'
      }
    ],
    name: 'mintBatch',
    outputs: [],
    stateMutability: 'payable',
    type: 'function'
  },
  {
    inputs: [
      {
        internalType: 'address',
        name: 'creatorContractAddress',
        type: 'address'
      },
      {
        internalType: 'uint256',
        name: 'claimIndex',
        type: 'uint256'
      },
      {
        components: [
          {
            internalType: 'uint32',
            name: 'totalMax',
            type: 'uint32'
          },
          {
            internalType: 'uint32',
            name: 'walletMax',
            type: 'uint32'
          },
          {
            internalType: 'uint48',
            name: 'startDate',
            type: 'uint48'
          },
          {
            internalType: 'uint48',
            name: 'endDate',
            type: 'uint48'
          },
          {
            internalType: 'enum IERC1155LazyPayableClaim.StorageProtocol',
            name: 'storageProtocol',
            type: 'uint8'
          },
          {
            internalType: 'bytes32',
            name: 'merkleRoot',
            type: 'bytes32'
          },
          {
            internalType: 'string',
            name: 'location',
            type: 'string'
          },
          {
            internalType: 'uint256',
            name: 'cost',
            type: 'uint256'
          },
          {
            internalType: 'address payable',
            name: 'paymentReceiver',
            type: 'address'
          }
        ],
        internalType: 'struct IERC1155LazyPayableClaim.ClaimParameters',
        name: 'claimParameters',
        type: 'tuple'
      }
    ],
    name: 'updateClaim',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function'
  },
  {
    inputs: [
      {
        internalType: 'address',
        name: 'creatorContractAddress',
        type: 'address'
      },
      {
        internalType: 'uint256',
        name: 'claimIndex',
        type: 'uint256'
      },
      {
        components: [
          {
            internalType: 'uint32',
            name: 'totalMax',
            type: 'uint32'
          },
          {
            internalType: 'uint32',
            name: 'walletMax',
            type: 'uint32'
          },
          {
            internalType: 'uint48',
            name: 'startDate',
            type: 'uint48'
          },
          {
            internalType: 'uint48',
            name: 'endDate',
            type: 'uint48'
          },
          {
            internalType: 'enum ILazyPayableClaim.StorageProtocol',
            name: 'storageProtocol',
            type: 'uint8'
          },
          {
            internalType: 'bytes32',
            name: 'merkleRoot',
            type: 'bytes32'
          },
          {
            internalType: 'string',
            name: 'location',
            type: 'string'
          },
          {
            internalType: 'uint256',
            name: 'cost',
            type: 'uint256'
          },
          {
            internalType: 'address payable',
            name: 'paymentReceiver',
            type: 'address'
          },
          {
            internalType: 'address',
            name: 'erc20',
            type: 'address'
          }
        ],
        internalType: 'struct IERC1155LazyPayableClaim.ClaimParameters',
        name: 'claimParameters',
        type: 'tuple'
      }
    ],
    name: 'updateClaim',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function'
  },
  {
    inputs: [
      {
        internalType: 'address',
        name: 'creatorContractAddress',
        type: 'address'
      },
      { internalType: 'uint256', name: 'instanceId', type: 'uint256' },
      {
        components: [
          { internalType: 'uint32', name: 'totalMax', type: 'uint32' },
          { internalType: 'uint32', name: 'walletMax', type: 'uint32' },
          { internalType: 'uint48', name: 'startDate', type: 'uint48' },
          { internalType: 'uint48', name: 'endDate', type: 'uint48' },
          {
            internalType: 'enum ILazyPayableClaim.StorageProtocol',
            name: 'storageProtocol',
            type: 'uint8'
          },
          { internalType: 'bytes32', name: 'merkleRoot', type: 'bytes32' },
          { internalType: 'string', name: 'location', type: 'string' },
          { internalType: 'uint256', name: 'cost', type: 'uint256' },
          {
            internalType: 'address payable',
            name: 'paymentReceiver',
            type: 'address'
          },
          { internalType: 'address', name: 'erc20', type: 'address' },
          { internalType: 'address', name: 'signingAddress', type: 'address' }
        ],
        internalType: 'struct IERC1155LazyPayableClaim.ClaimParameters',
        name: 'claimParameters',
        type: 'tuple'
      }
    ],
    name: 'initializeClaim',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function'
  }
]);
