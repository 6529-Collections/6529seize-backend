import { Network } from 'alchemy-sdk';

export const TDH_BLOCKS_TABLE = 'tdh_blocks';
export const TRANSACTIONS_TABLE = 'transactions';
export const TRANSACTIONS_MEME_LAB_TABLE = 'transactions_meme_lab';
export const TRANSACTIONS_REMAKE_TABLE = 'transactions_remake';
export const NFTS_TABLE = 'nfts';
export const NFTS_MEME_LAB_TABLE = 'nfts_meme_lab';
export const ARTISTS_TABLE = 'artists';
export const OWNERS_TABLE = 'owners';
export const OWNERS_MEME_LAB_TABLE = 'owners_meme_lab';
export const OWNERS_TAGS_TABLE = 'owners_tags';
export const OWNERS_METRICS_TABLE = 'owners_metrics';
export const MEMES_EXTENDED_DATA_TABLE = 'memes_extended_data';
export const LAB_EXTENDED_DATA_TABLE = 'lab_extended_data';
export const WALLETS_TDH_TABLE = 'tdh';
export const UPLOADS_TABLE = 'uploads';
export const ENS_TABLE = 'ens';

export const MEMES_CONTRACT = '0x33FD426905F149f8376e227d0C9D3340AaD17aF1';
export const GRADIENT_CONTRACT = '0x0c58ef43ff3032005e472cb5709f8908acb00205';
export const MEMELAB_CONTRACT = '0x4db52a61dc491e15a2f78f5ac001c14ffe3568cb';
export const NULL_ADDRESS = '0x0000000000000000000000000000000000000000';
export const MANIFOLD = '0x3A3548e060Be10c2614d0a4Cb0c03CC9093fD799';
export const PUNK_6529 = '0xfd22004806a6846ea67ad883356be810f0428793';
export const SIX529 = '0xB7d6ed1d7038BaB3634eE005FA37b925B11E9b13';
export const SIX529_ER = '0xE359aB04cEC41AC8C62bc5016C10C749c7De5480';
export const SIX529_COLLECTIONS = '0x4B76837F8D8Ad0A28590d06E53dCD44b6B7D4554';
export const SIX529_MUSEUM = '0xc6400A5584db71e41B0E5dFbdC769b54B91256CD';
export const ENS_ADDRESS = '0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85';

export const ALCHEMY_SETTINGS = {
  network: Network.ETH_MAINNET,
  maxRetries: 10
};

export const INFURA_KEY = 'b496145d088a4fe5a5861a6db9ee2034';

export const NFT_ORIGINAL_IMAGE_LINK =
  'https://d3lqz0a4bldqgf.cloudfront.net/images/original/';

export const NFT_SCALED1000_IMAGE_LINK =
  'https://d3lqz0a4bldqgf.cloudfront.net/images/scaled_x1000/';

export const NFT_SCALED450_IMAGE_LINK =
  'https://d3lqz0a4bldqgf.cloudfront.net/images/scaled_x450/';

export const NFT_SCALED60_IMAGE_LINK =
  'https://d3lqz0a4bldqgf.cloudfront.net/images/scaled_x60/';

export const NFT_VIDEO_LINK = 'https://d3lqz0a4bldqgf.cloudfront.net/videos/';
export const NFT_HTML_LINK = 'https://d3lqz0a4bldqgf.cloudfront.net/html/';

export const SEAPORT_ABI: string = JSON.stringify([
  {
    inputs: [
      {
        internalType: 'address',
        name: 'conduitController',
        type: 'address'
      }
    ],
    stateMutability: 'nonpayable',
    type: 'constructor'
  },
  { inputs: [], name: 'BadContractSignature', type: 'error' },
  { inputs: [], name: 'BadFraction', type: 'error' },
  {
    inputs: [
      { internalType: 'address', name: 'token', type: 'address' },
      { internalType: 'address', name: 'from', type: 'address' },
      { internalType: 'address', name: 'to', type: 'address' },
      { internalType: 'uint256', name: 'amount', type: 'uint256' }
    ],
    name: 'BadReturnValueFromERC20OnTransfer',
    type: 'error'
  },
  {
    inputs: [{ internalType: 'uint8', name: 'v', type: 'uint8' }],
    name: 'BadSignatureV',
    type: 'error'
  },
  {
    inputs: [],
    name: 'ConsiderationCriteriaResolverOutOfRange',
    type: 'error'
  },
  {
    inputs: [
      { internalType: 'uint256', name: 'orderIndex', type: 'uint256' },
      {
        internalType: 'uint256',
        name: 'considerationIndex',
        type: 'uint256'
      },
      {
        internalType: 'uint256',
        name: 'shortfallAmount',
        type: 'uint256'
      }
    ],
    name: 'ConsiderationNotMet',
    type: 'error'
  },
  { inputs: [], name: 'CriteriaNotEnabledForItem', type: 'error' },
  {
    inputs: [
      { internalType: 'address', name: 'token', type: 'address' },
      { internalType: 'address', name: 'from', type: 'address' },
      { internalType: 'address', name: 'to', type: 'address' },
      {
        internalType: 'uint256[]',
        name: 'identifiers',
        type: 'uint256[]'
      },
      { internalType: 'uint256[]', name: 'amounts', type: 'uint256[]' }
    ],
    name: 'ERC1155BatchTransferGenericFailure',
    type: 'error'
  },
  {
    inputs: [
      { internalType: 'address', name: 'account', type: 'address' },
      { internalType: 'uint256', name: 'amount', type: 'uint256' }
    ],
    name: 'EtherTransferGenericFailure',
    type: 'error'
  },
  { inputs: [], name: 'InexactFraction', type: 'error' },
  { inputs: [], name: 'InsufficientEtherSupplied', type: 'error' },
  { inputs: [], name: 'Invalid1155BatchTransferEncoding', type: 'error' },
  {
    inputs: [],
    name: 'InvalidBasicOrderParameterEncoding',
    type: 'error'
  },
  {
    inputs: [{ internalType: 'address', name: 'conduit', type: 'address' }],
    name: 'InvalidCallToConduit',
    type: 'error'
  },
  { inputs: [], name: 'InvalidCanceller', type: 'error' },
  {
    inputs: [
      { internalType: 'bytes32', name: 'conduitKey', type: 'bytes32' },
      { internalType: 'address', name: 'conduit', type: 'address' }
    ],
    name: 'InvalidConduit',
    type: 'error'
  },
  { inputs: [], name: 'InvalidERC721TransferAmount', type: 'error' },
  { inputs: [], name: 'InvalidFulfillmentComponentData', type: 'error' },
  {
    inputs: [{ internalType: 'uint256', name: 'value', type: 'uint256' }],
    name: 'InvalidMsgValue',
    type: 'error'
  },
  { inputs: [], name: 'InvalidNativeOfferItem', type: 'error' },
  { inputs: [], name: 'InvalidProof', type: 'error' },
  {
    inputs: [{ internalType: 'bytes32', name: 'orderHash', type: 'bytes32' }],
    name: 'InvalidRestrictedOrder',
    type: 'error'
  },
  { inputs: [], name: 'InvalidSignature', type: 'error' },
  { inputs: [], name: 'InvalidSigner', type: 'error' },
  { inputs: [], name: 'InvalidTime', type: 'error' },
  {
    inputs: [],
    name: 'MismatchedFulfillmentOfferAndConsiderationComponents',
    type: 'error'
  },
  {
    inputs: [{ internalType: 'enum Side', name: 'side', type: 'uint8' }],
    name: 'MissingFulfillmentComponentOnAggregation',
    type: 'error'
  },
  { inputs: [], name: 'MissingItemAmount', type: 'error' },
  {
    inputs: [],
    name: 'MissingOriginalConsiderationItems',
    type: 'error'
  },
  {
    inputs: [{ internalType: 'address', name: 'account', type: 'address' }],
    name: 'NoContract',
    type: 'error'
  },
  { inputs: [], name: 'NoReentrantCalls', type: 'error' },
  { inputs: [], name: 'NoSpecifiedOrdersAvailable', type: 'error' },
  {
    inputs: [],
    name: 'OfferAndConsiderationRequiredOnFulfillment',
    type: 'error'
  },
  { inputs: [], name: 'OfferCriteriaResolverOutOfRange', type: 'error' },
  {
    inputs: [{ internalType: 'bytes32', name: 'orderHash', type: 'bytes32' }],
    name: 'OrderAlreadyFilled',
    type: 'error'
  },
  { inputs: [], name: 'OrderCriteriaResolverOutOfRange', type: 'error' },
  {
    inputs: [{ internalType: 'bytes32', name: 'orderHash', type: 'bytes32' }],
    name: 'OrderIsCancelled',
    type: 'error'
  },
  {
    inputs: [{ internalType: 'bytes32', name: 'orderHash', type: 'bytes32' }],
    name: 'OrderPartiallyFilled',
    type: 'error'
  },
  { inputs: [], name: 'PartialFillsNotEnabledForOrder', type: 'error' },
  {
    inputs: [
      { internalType: 'address', name: 'token', type: 'address' },
      { internalType: 'address', name: 'from', type: 'address' },
      { internalType: 'address', name: 'to', type: 'address' },
      { internalType: 'uint256', name: 'identifier', type: 'uint256' },
      { internalType: 'uint256', name: 'amount', type: 'uint256' }
    ],
    name: 'TokenTransferGenericFailure',
    type: 'error'
  },
  { inputs: [], name: 'UnresolvedConsiderationCriteria', type: 'error' },
  { inputs: [], name: 'UnresolvedOfferCriteria', type: 'error' },
  { inputs: [], name: 'UnusedItemParameters', type: 'error' },
  {
    anonymous: false,
    inputs: [
      {
        indexed: false,
        internalType: 'uint256',
        name: 'newCounter',
        type: 'uint256'
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'offerer',
        type: 'address'
      }
    ],
    name: 'CounterIncremented',
    type: 'event'
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: false,
        internalType: 'bytes32',
        name: 'orderHash',
        type: 'bytes32'
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'offerer',
        type: 'address'
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'zone',
        type: 'address'
      }
    ],
    name: 'OrderCancelled',
    type: 'event'
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: false,
        internalType: 'bytes32',
        name: 'orderHash',
        type: 'bytes32'
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'offerer',
        type: 'address'
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'zone',
        type: 'address'
      },
      {
        indexed: false,
        internalType: 'address',
        name: 'recipient',
        type: 'address'
      },
      {
        components: [
          {
            internalType: 'enum ItemType',
            name: 'itemType',
            type: 'uint8'
          },
          { internalType: 'address', name: 'token', type: 'address' },
          {
            internalType: 'uint256',
            name: 'identifier',
            type: 'uint256'
          },
          { internalType: 'uint256', name: 'amount', type: 'uint256' }
        ],
        indexed: false,
        internalType: 'struct SpentItem[]',
        name: 'offer',
        type: 'tuple[]'
      },
      {
        components: [
          {
            internalType: 'enum ItemType',
            name: 'itemType',
            type: 'uint8'
          },
          { internalType: 'address', name: 'token', type: 'address' },
          {
            internalType: 'uint256',
            name: 'identifier',
            type: 'uint256'
          },
          { internalType: 'uint256', name: 'amount', type: 'uint256' },
          {
            internalType: 'address payable',
            name: 'recipient',
            type: 'address'
          }
        ],
        indexed: false,
        internalType: 'struct ReceivedItem[]',
        name: 'consideration',
        type: 'tuple[]'
      }
    ],
    name: 'OrderFulfilled',
    type: 'event'
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: false,
        internalType: 'bytes32',
        name: 'orderHash',
        type: 'bytes32'
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'offerer',
        type: 'address'
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'zone',
        type: 'address'
      }
    ],
    name: 'OrderValidated',
    type: 'event'
  },
  {
    inputs: [
      {
        components: [
          { internalType: 'address', name: 'offerer', type: 'address' },
          { internalType: 'address', name: 'zone', type: 'address' },
          {
            components: [
              {
                internalType: 'enum ItemType',
                name: 'itemType',
                type: 'uint8'
              },
              { internalType: 'address', name: 'token', type: 'address' },
              {
                internalType: 'uint256',
                name: 'identifierOrCriteria',
                type: 'uint256'
              },
              {
                internalType: 'uint256',
                name: 'startAmount',
                type: 'uint256'
              },
              {
                internalType: 'uint256',
                name: 'endAmount',
                type: 'uint256'
              }
            ],
            internalType: 'struct OfferItem[]',
            name: 'offer',
            type: 'tuple[]'
          },
          {
            components: [
              {
                internalType: 'enum ItemType',
                name: 'itemType',
                type: 'uint8'
              },
              { internalType: 'address', name: 'token', type: 'address' },
              {
                internalType: 'uint256',
                name: 'identifierOrCriteria',
                type: 'uint256'
              },
              {
                internalType: 'uint256',
                name: 'startAmount',
                type: 'uint256'
              },
              {
                internalType: 'uint256',
                name: 'endAmount',
                type: 'uint256'
              },
              {
                internalType: 'address payable',
                name: 'recipient',
                type: 'address'
              }
            ],
            internalType: 'struct ConsiderationItem[]',
            name: 'consideration',
            type: 'tuple[]'
          },
          {
            internalType: 'enum OrderType',
            name: 'orderType',
            type: 'uint8'
          },
          { internalType: 'uint256', name: 'startTime', type: 'uint256' },
          { internalType: 'uint256', name: 'endTime', type: 'uint256' },
          { internalType: 'bytes32', name: 'zoneHash', type: 'bytes32' },
          { internalType: 'uint256', name: 'salt', type: 'uint256' },
          {
            internalType: 'bytes32',
            name: 'conduitKey',
            type: 'bytes32'
          },
          { internalType: 'uint256', name: 'counter', type: 'uint256' }
        ],
        internalType: 'struct OrderComponents[]',
        name: 'orders',
        type: 'tuple[]'
      }
    ],
    name: 'cancel',
    outputs: [{ internalType: 'bool', name: 'cancelled', type: 'bool' }],
    stateMutability: 'nonpayable',
    type: 'function'
  },
  {
    inputs: [
      {
        components: [
          {
            components: [
              {
                internalType: 'address',
                name: 'offerer',
                type: 'address'
              },
              { internalType: 'address', name: 'zone', type: 'address' },
              {
                components: [
                  {
                    internalType: 'enum ItemType',
                    name: 'itemType',
                    type: 'uint8'
                  },
                  {
                    internalType: 'address',
                    name: 'token',
                    type: 'address'
                  },
                  {
                    internalType: 'uint256',
                    name: 'identifierOrCriteria',
                    type: 'uint256'
                  },
                  {
                    internalType: 'uint256',
                    name: 'startAmount',
                    type: 'uint256'
                  },
                  {
                    internalType: 'uint256',
                    name: 'endAmount',
                    type: 'uint256'
                  }
                ],
                internalType: 'struct OfferItem[]',
                name: 'offer',
                type: 'tuple[]'
              },
              {
                components: [
                  {
                    internalType: 'enum ItemType',
                    name: 'itemType',
                    type: 'uint8'
                  },
                  {
                    internalType: 'address',
                    name: 'token',
                    type: 'address'
                  },
                  {
                    internalType: 'uint256',
                    name: 'identifierOrCriteria',
                    type: 'uint256'
                  },
                  {
                    internalType: 'uint256',
                    name: 'startAmount',
                    type: 'uint256'
                  },
                  {
                    internalType: 'uint256',
                    name: 'endAmount',
                    type: 'uint256'
                  },
                  {
                    internalType: 'address payable',
                    name: 'recipient',
                    type: 'address'
                  }
                ],
                internalType: 'struct ConsiderationItem[]',
                name: 'consideration',
                type: 'tuple[]'
              },
              {
                internalType: 'enum OrderType',
                name: 'orderType',
                type: 'uint8'
              },
              {
                internalType: 'uint256',
                name: 'startTime',
                type: 'uint256'
              },
              {
                internalType: 'uint256',
                name: 'endTime',
                type: 'uint256'
              },
              {
                internalType: 'bytes32',
                name: 'zoneHash',
                type: 'bytes32'
              },
              { internalType: 'uint256', name: 'salt', type: 'uint256' },
              {
                internalType: 'bytes32',
                name: 'conduitKey',
                type: 'bytes32'
              },
              {
                internalType: 'uint256',
                name: 'totalOriginalConsiderationItems',
                type: 'uint256'
              }
            ],
            internalType: 'struct OrderParameters',
            name: 'parameters',
            type: 'tuple'
          },
          { internalType: 'uint120', name: 'numerator', type: 'uint120' },
          {
            internalType: 'uint120',
            name: 'denominator',
            type: 'uint120'
          },
          { internalType: 'bytes', name: 'signature', type: 'bytes' },
          { internalType: 'bytes', name: 'extraData', type: 'bytes' }
        ],
        internalType: 'struct AdvancedOrder',
        name: 'advancedOrder',
        type: 'tuple'
      },
      {
        components: [
          {
            internalType: 'uint256',
            name: 'orderIndex',
            type: 'uint256'
          },
          { internalType: 'enum Side', name: 'side', type: 'uint8' },
          { internalType: 'uint256', name: 'index', type: 'uint256' },
          {
            internalType: 'uint256',
            name: 'identifier',
            type: 'uint256'
          },
          {
            internalType: 'bytes32[]',
            name: 'criteriaProof',
            type: 'bytes32[]'
          }
        ],
        internalType: 'struct CriteriaResolver[]',
        name: 'criteriaResolvers',
        type: 'tuple[]'
      },
      {
        internalType: 'bytes32',
        name: 'fulfillerConduitKey',
        type: 'bytes32'
      },
      { internalType: 'address', name: 'recipient', type: 'address' }
    ],
    name: 'fulfillAdvancedOrder',
    outputs: [{ internalType: 'bool', name: 'fulfilled', type: 'bool' }],
    stateMutability: 'payable',
    type: 'function'
  },
  {
    inputs: [
      {
        components: [
          {
            components: [
              {
                internalType: 'address',
                name: 'offerer',
                type: 'address'
              },
              { internalType: 'address', name: 'zone', type: 'address' },
              {
                components: [
                  {
                    internalType: 'enum ItemType',
                    name: 'itemType',
                    type: 'uint8'
                  },
                  {
                    internalType: 'address',
                    name: 'token',
                    type: 'address'
                  },
                  {
                    internalType: 'uint256',
                    name: 'identifierOrCriteria',
                    type: 'uint256'
                  },
                  {
                    internalType: 'uint256',
                    name: 'startAmount',
                    type: 'uint256'
                  },
                  {
                    internalType: 'uint256',
                    name: 'endAmount',
                    type: 'uint256'
                  }
                ],
                internalType: 'struct OfferItem[]',
                name: 'offer',
                type: 'tuple[]'
              },
              {
                components: [
                  {
                    internalType: 'enum ItemType',
                    name: 'itemType',
                    type: 'uint8'
                  },
                  {
                    internalType: 'address',
                    name: 'token',
                    type: 'address'
                  },
                  {
                    internalType: 'uint256',
                    name: 'identifierOrCriteria',
                    type: 'uint256'
                  },
                  {
                    internalType: 'uint256',
                    name: 'startAmount',
                    type: 'uint256'
                  },
                  {
                    internalType: 'uint256',
                    name: 'endAmount',
                    type: 'uint256'
                  },
                  {
                    internalType: 'address payable',
                    name: 'recipient',
                    type: 'address'
                  }
                ],
                internalType: 'struct ConsiderationItem[]',
                name: 'consideration',
                type: 'tuple[]'
              },
              {
                internalType: 'enum OrderType',
                name: 'orderType',
                type: 'uint8'
              },
              {
                internalType: 'uint256',
                name: 'startTime',
                type: 'uint256'
              },
              {
                internalType: 'uint256',
                name: 'endTime',
                type: 'uint256'
              },
              {
                internalType: 'bytes32',
                name: 'zoneHash',
                type: 'bytes32'
              },
              { internalType: 'uint256', name: 'salt', type: 'uint256' },
              {
                internalType: 'bytes32',
                name: 'conduitKey',
                type: 'bytes32'
              },
              {
                internalType: 'uint256',
                name: 'totalOriginalConsiderationItems',
                type: 'uint256'
              }
            ],
            internalType: 'struct OrderParameters',
            name: 'parameters',
            type: 'tuple'
          },
          { internalType: 'uint120', name: 'numerator', type: 'uint120' },
          {
            internalType: 'uint120',
            name: 'denominator',
            type: 'uint120'
          },
          { internalType: 'bytes', name: 'signature', type: 'bytes' },
          { internalType: 'bytes', name: 'extraData', type: 'bytes' }
        ],
        internalType: 'struct AdvancedOrder[]',
        name: 'advancedOrders',
        type: 'tuple[]'
      },
      {
        components: [
          {
            internalType: 'uint256',
            name: 'orderIndex',
            type: 'uint256'
          },
          { internalType: 'enum Side', name: 'side', type: 'uint8' },
          { internalType: 'uint256', name: 'index', type: 'uint256' },
          {
            internalType: 'uint256',
            name: 'identifier',
            type: 'uint256'
          },
          {
            internalType: 'bytes32[]',
            name: 'criteriaProof',
            type: 'bytes32[]'
          }
        ],
        internalType: 'struct CriteriaResolver[]',
        name: 'criteriaResolvers',
        type: 'tuple[]'
      },
      {
        components: [
          {
            internalType: 'uint256',
            name: 'orderIndex',
            type: 'uint256'
          },
          { internalType: 'uint256', name: 'itemIndex', type: 'uint256' }
        ],
        internalType: 'struct FulfillmentComponent[][]',
        name: 'offerFulfillments',
        type: 'tuple[][]'
      },
      {
        components: [
          {
            internalType: 'uint256',
            name: 'orderIndex',
            type: 'uint256'
          },
          { internalType: 'uint256', name: 'itemIndex', type: 'uint256' }
        ],
        internalType: 'struct FulfillmentComponent[][]',
        name: 'considerationFulfillments',
        type: 'tuple[][]'
      },
      {
        internalType: 'bytes32',
        name: 'fulfillerConduitKey',
        type: 'bytes32'
      },
      { internalType: 'address', name: 'recipient', type: 'address' },
      {
        internalType: 'uint256',
        name: 'maximumFulfilled',
        type: 'uint256'
      }
    ],
    name: 'fulfillAvailableAdvancedOrders',
    outputs: [
      { internalType: 'bool[]', name: 'availableOrders', type: 'bool[]' },
      {
        components: [
          {
            components: [
              {
                internalType: 'enum ItemType',
                name: 'itemType',
                type: 'uint8'
              },
              { internalType: 'address', name: 'token', type: 'address' },
              {
                internalType: 'uint256',
                name: 'identifier',
                type: 'uint256'
              },
              {
                internalType: 'uint256',
                name: 'amount',
                type: 'uint256'
              },
              {
                internalType: 'address payable',
                name: 'recipient',
                type: 'address'
              }
            ],
            internalType: 'struct ReceivedItem',
            name: 'item',
            type: 'tuple'
          },
          { internalType: 'address', name: 'offerer', type: 'address' },
          { internalType: 'bytes32', name: 'conduitKey', type: 'bytes32' }
        ],
        internalType: 'struct Execution[]',
        name: 'executions',
        type: 'tuple[]'
      }
    ],
    stateMutability: 'payable',
    type: 'function'
  },
  {
    inputs: [
      {
        components: [
          {
            components: [
              {
                internalType: 'address',
                name: 'offerer',
                type: 'address'
              },
              { internalType: 'address', name: 'zone', type: 'address' },
              {
                components: [
                  {
                    internalType: 'enum ItemType',
                    name: 'itemType',
                    type: 'uint8'
                  },
                  {
                    internalType: 'address',
                    name: 'token',
                    type: 'address'
                  },
                  {
                    internalType: 'uint256',
                    name: 'identifierOrCriteria',
                    type: 'uint256'
                  },
                  {
                    internalType: 'uint256',
                    name: 'startAmount',
                    type: 'uint256'
                  },
                  {
                    internalType: 'uint256',
                    name: 'endAmount',
                    type: 'uint256'
                  }
                ],
                internalType: 'struct OfferItem[]',
                name: 'offer',
                type: 'tuple[]'
              },
              {
                components: [
                  {
                    internalType: 'enum ItemType',
                    name: 'itemType',
                    type: 'uint8'
                  },
                  {
                    internalType: 'address',
                    name: 'token',
                    type: 'address'
                  },
                  {
                    internalType: 'uint256',
                    name: 'identifierOrCriteria',
                    type: 'uint256'
                  },
                  {
                    internalType: 'uint256',
                    name: 'startAmount',
                    type: 'uint256'
                  },
                  {
                    internalType: 'uint256',
                    name: 'endAmount',
                    type: 'uint256'
                  },
                  {
                    internalType: 'address payable',
                    name: 'recipient',
                    type: 'address'
                  }
                ],
                internalType: 'struct ConsiderationItem[]',
                name: 'consideration',
                type: 'tuple[]'
              },
              {
                internalType: 'enum OrderType',
                name: 'orderType',
                type: 'uint8'
              },
              {
                internalType: 'uint256',
                name: 'startTime',
                type: 'uint256'
              },
              {
                internalType: 'uint256',
                name: 'endTime',
                type: 'uint256'
              },
              {
                internalType: 'bytes32',
                name: 'zoneHash',
                type: 'bytes32'
              },
              { internalType: 'uint256', name: 'salt', type: 'uint256' },
              {
                internalType: 'bytes32',
                name: 'conduitKey',
                type: 'bytes32'
              },
              {
                internalType: 'uint256',
                name: 'totalOriginalConsiderationItems',
                type: 'uint256'
              }
            ],
            internalType: 'struct OrderParameters',
            name: 'parameters',
            type: 'tuple'
          },
          { internalType: 'bytes', name: 'signature', type: 'bytes' }
        ],
        internalType: 'struct Order[]',
        name: 'orders',
        type: 'tuple[]'
      },
      {
        components: [
          {
            internalType: 'uint256',
            name: 'orderIndex',
            type: 'uint256'
          },
          { internalType: 'uint256', name: 'itemIndex', type: 'uint256' }
        ],
        internalType: 'struct FulfillmentComponent[][]',
        name: 'offerFulfillments',
        type: 'tuple[][]'
      },
      {
        components: [
          {
            internalType: 'uint256',
            name: 'orderIndex',
            type: 'uint256'
          },
          { internalType: 'uint256', name: 'itemIndex', type: 'uint256' }
        ],
        internalType: 'struct FulfillmentComponent[][]',
        name: 'considerationFulfillments',
        type: 'tuple[][]'
      },
      {
        internalType: 'bytes32',
        name: 'fulfillerConduitKey',
        type: 'bytes32'
      },
      {
        internalType: 'uint256',
        name: 'maximumFulfilled',
        type: 'uint256'
      }
    ],
    name: 'fulfillAvailableOrders',
    outputs: [
      { internalType: 'bool[]', name: 'availableOrders', type: 'bool[]' },
      {
        components: [
          {
            components: [
              {
                internalType: 'enum ItemType',
                name: 'itemType',
                type: 'uint8'
              },
              { internalType: 'address', name: 'token', type: 'address' },
              {
                internalType: 'uint256',
                name: 'identifier',
                type: 'uint256'
              },
              {
                internalType: 'uint256',
                name: 'amount',
                type: 'uint256'
              },
              {
                internalType: 'address payable',
                name: 'recipient',
                type: 'address'
              }
            ],
            internalType: 'struct ReceivedItem',
            name: 'item',
            type: 'tuple'
          },
          { internalType: 'address', name: 'offerer', type: 'address' },
          { internalType: 'bytes32', name: 'conduitKey', type: 'bytes32' }
        ],
        internalType: 'struct Execution[]',
        name: 'executions',
        type: 'tuple[]'
      }
    ],
    stateMutability: 'payable',
    type: 'function'
  },
  {
    inputs: [
      {
        components: [
          {
            internalType: 'address',
            name: 'considerationToken',
            type: 'address'
          },
          {
            internalType: 'uint256',
            name: 'considerationIdentifier',
            type: 'uint256'
          },
          {
            internalType: 'uint256',
            name: 'considerationAmount',
            type: 'uint256'
          },
          {
            internalType: 'address payable',
            name: 'offerer',
            type: 'address'
          },
          { internalType: 'address', name: 'zone', type: 'address' },
          {
            internalType: 'address',
            name: 'offerToken',
            type: 'address'
          },
          {
            internalType: 'uint256',
            name: 'offerIdentifier',
            type: 'uint256'
          },
          {
            internalType: 'uint256',
            name: 'offerAmount',
            type: 'uint256'
          },
          {
            internalType: 'enum BasicOrderType',
            name: 'basicOrderType',
            type: 'uint8'
          },
          { internalType: 'uint256', name: 'startTime', type: 'uint256' },
          { internalType: 'uint256', name: 'endTime', type: 'uint256' },
          { internalType: 'bytes32', name: 'zoneHash', type: 'bytes32' },
          { internalType: 'uint256', name: 'salt', type: 'uint256' },
          {
            internalType: 'bytes32',
            name: 'offererConduitKey',
            type: 'bytes32'
          },
          {
            internalType: 'bytes32',
            name: 'fulfillerConduitKey',
            type: 'bytes32'
          },
          {
            internalType: 'uint256',
            name: 'totalOriginalAdditionalRecipients',
            type: 'uint256'
          },
          {
            components: [
              {
                internalType: 'uint256',
                name: 'amount',
                type: 'uint256'
              },
              {
                internalType: 'address payable',
                name: 'recipient',
                type: 'address'
              }
            ],
            internalType: 'struct AdditionalRecipient[]',
            name: 'additionalRecipients',
            type: 'tuple[]'
          },
          { internalType: 'bytes', name: 'signature', type: 'bytes' }
        ],
        internalType: 'struct BasicOrderParameters',
        name: 'parameters',
        type: 'tuple'
      }
    ],
    name: 'fulfillBasicOrder',
    outputs: [{ internalType: 'bool', name: 'fulfilled', type: 'bool' }],
    stateMutability: 'payable',
    type: 'function'
  },
  {
    inputs: [
      {
        components: [
          {
            components: [
              {
                internalType: 'address',
                name: 'offerer',
                type: 'address'
              },
              { internalType: 'address', name: 'zone', type: 'address' },
              {
                components: [
                  {
                    internalType: 'enum ItemType',
                    name: 'itemType',
                    type: 'uint8'
                  },
                  {
                    internalType: 'address',
                    name: 'token',
                    type: 'address'
                  },
                  {
                    internalType: 'uint256',
                    name: 'identifierOrCriteria',
                    type: 'uint256'
                  },
                  {
                    internalType: 'uint256',
                    name: 'startAmount',
                    type: 'uint256'
                  },
                  {
                    internalType: 'uint256',
                    name: 'endAmount',
                    type: 'uint256'
                  }
                ],
                internalType: 'struct OfferItem[]',
                name: 'offer',
                type: 'tuple[]'
              },
              {
                components: [
                  {
                    internalType: 'enum ItemType',
                    name: 'itemType',
                    type: 'uint8'
                  },
                  {
                    internalType: 'address',
                    name: 'token',
                    type: 'address'
                  },
                  {
                    internalType: 'uint256',
                    name: 'identifierOrCriteria',
                    type: 'uint256'
                  },
                  {
                    internalType: 'uint256',
                    name: 'startAmount',
                    type: 'uint256'
                  },
                  {
                    internalType: 'uint256',
                    name: 'endAmount',
                    type: 'uint256'
                  },
                  {
                    internalType: 'address payable',
                    name: 'recipient',
                    type: 'address'
                  }
                ],
                internalType: 'struct ConsiderationItem[]',
                name: 'consideration',
                type: 'tuple[]'
              },
              {
                internalType: 'enum OrderType',
                name: 'orderType',
                type: 'uint8'
              },
              {
                internalType: 'uint256',
                name: 'startTime',
                type: 'uint256'
              },
              {
                internalType: 'uint256',
                name: 'endTime',
                type: 'uint256'
              },
              {
                internalType: 'bytes32',
                name: 'zoneHash',
                type: 'bytes32'
              },
              { internalType: 'uint256', name: 'salt', type: 'uint256' },
              {
                internalType: 'bytes32',
                name: 'conduitKey',
                type: 'bytes32'
              },
              {
                internalType: 'uint256',
                name: 'totalOriginalConsiderationItems',
                type: 'uint256'
              }
            ],
            internalType: 'struct OrderParameters',
            name: 'parameters',
            type: 'tuple'
          },
          { internalType: 'bytes', name: 'signature', type: 'bytes' }
        ],
        internalType: 'struct Order',
        name: 'order',
        type: 'tuple'
      },
      {
        internalType: 'bytes32',
        name: 'fulfillerConduitKey',
        type: 'bytes32'
      }
    ],
    name: 'fulfillOrder',
    outputs: [{ internalType: 'bool', name: 'fulfilled', type: 'bool' }],
    stateMutability: 'payable',
    type: 'function'
  },
  {
    inputs: [{ internalType: 'address', name: 'offerer', type: 'address' }],
    name: 'getCounter',
    outputs: [{ internalType: 'uint256', name: 'counter', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function'
  },
  {
    inputs: [
      {
        components: [
          { internalType: 'address', name: 'offerer', type: 'address' },
          { internalType: 'address', name: 'zone', type: 'address' },
          {
            components: [
              {
                internalType: 'enum ItemType',
                name: 'itemType',
                type: 'uint8'
              },
              { internalType: 'address', name: 'token', type: 'address' },
              {
                internalType: 'uint256',
                name: 'identifierOrCriteria',
                type: 'uint256'
              },
              {
                internalType: 'uint256',
                name: 'startAmount',
                type: 'uint256'
              },
              {
                internalType: 'uint256',
                name: 'endAmount',
                type: 'uint256'
              }
            ],
            internalType: 'struct OfferItem[]',
            name: 'offer',
            type: 'tuple[]'
          },
          {
            components: [
              {
                internalType: 'enum ItemType',
                name: 'itemType',
                type: 'uint8'
              },
              { internalType: 'address', name: 'token', type: 'address' },
              {
                internalType: 'uint256',
                name: 'identifierOrCriteria',
                type: 'uint256'
              },
              {
                internalType: 'uint256',
                name: 'startAmount',
                type: 'uint256'
              },
              {
                internalType: 'uint256',
                name: 'endAmount',
                type: 'uint256'
              },
              {
                internalType: 'address payable',
                name: 'recipient',
                type: 'address'
              }
            ],
            internalType: 'struct ConsiderationItem[]',
            name: 'consideration',
            type: 'tuple[]'
          },
          {
            internalType: 'enum OrderType',
            name: 'orderType',
            type: 'uint8'
          },
          { internalType: 'uint256', name: 'startTime', type: 'uint256' },
          { internalType: 'uint256', name: 'endTime', type: 'uint256' },
          { internalType: 'bytes32', name: 'zoneHash', type: 'bytes32' },
          { internalType: 'uint256', name: 'salt', type: 'uint256' },
          {
            internalType: 'bytes32',
            name: 'conduitKey',
            type: 'bytes32'
          },
          { internalType: 'uint256', name: 'counter', type: 'uint256' }
        ],
        internalType: 'struct OrderComponents',
        name: 'order',
        type: 'tuple'
      }
    ],
    name: 'getOrderHash',
    outputs: [{ internalType: 'bytes32', name: 'orderHash', type: 'bytes32' }],
    stateMutability: 'view',
    type: 'function'
  },
  {
    inputs: [{ internalType: 'bytes32', name: 'orderHash', type: 'bytes32' }],
    name: 'getOrderStatus',
    outputs: [
      { internalType: 'bool', name: 'isValidated', type: 'bool' },
      { internalType: 'bool', name: 'isCancelled', type: 'bool' },
      { internalType: 'uint256', name: 'totalFilled', type: 'uint256' },
      { internalType: 'uint256', name: 'totalSize', type: 'uint256' }
    ],
    stateMutability: 'view',
    type: 'function'
  },
  {
    inputs: [],
    name: 'incrementCounter',
    outputs: [{ internalType: 'uint256', name: 'newCounter', type: 'uint256' }],
    stateMutability: 'nonpayable',
    type: 'function'
  },
  {
    inputs: [],
    name: 'information',
    outputs: [
      { internalType: 'string', name: 'version', type: 'string' },
      {
        internalType: 'bytes32',
        name: 'domainSeparator',
        type: 'bytes32'
      },
      {
        internalType: 'address',
        name: 'conduitController',
        type: 'address'
      }
    ],
    stateMutability: 'view',
    type: 'function'
  },
  {
    inputs: [
      {
        components: [
          {
            components: [
              {
                internalType: 'address',
                name: 'offerer',
                type: 'address'
              },
              { internalType: 'address', name: 'zone', type: 'address' },
              {
                components: [
                  {
                    internalType: 'enum ItemType',
                    name: 'itemType',
                    type: 'uint8'
                  },
                  {
                    internalType: 'address',
                    name: 'token',
                    type: 'address'
                  },
                  {
                    internalType: 'uint256',
                    name: 'identifierOrCriteria',
                    type: 'uint256'
                  },
                  {
                    internalType: 'uint256',
                    name: 'startAmount',
                    type: 'uint256'
                  },
                  {
                    internalType: 'uint256',
                    name: 'endAmount',
                    type: 'uint256'
                  }
                ],
                internalType: 'struct OfferItem[]',
                name: 'offer',
                type: 'tuple[]'
              },
              {
                components: [
                  {
                    internalType: 'enum ItemType',
                    name: 'itemType',
                    type: 'uint8'
                  },
                  {
                    internalType: 'address',
                    name: 'token',
                    type: 'address'
                  },
                  {
                    internalType: 'uint256',
                    name: 'identifierOrCriteria',
                    type: 'uint256'
                  },
                  {
                    internalType: 'uint256',
                    name: 'startAmount',
                    type: 'uint256'
                  },
                  {
                    internalType: 'uint256',
                    name: 'endAmount',
                    type: 'uint256'
                  },
                  {
                    internalType: 'address payable',
                    name: 'recipient',
                    type: 'address'
                  }
                ],
                internalType: 'struct ConsiderationItem[]',
                name: 'consideration',
                type: 'tuple[]'
              },
              {
                internalType: 'enum OrderType',
                name: 'orderType',
                type: 'uint8'
              },
              {
                internalType: 'uint256',
                name: 'startTime',
                type: 'uint256'
              },
              {
                internalType: 'uint256',
                name: 'endTime',
                type: 'uint256'
              },
              {
                internalType: 'bytes32',
                name: 'zoneHash',
                type: 'bytes32'
              },
              { internalType: 'uint256', name: 'salt', type: 'uint256' },
              {
                internalType: 'bytes32',
                name: 'conduitKey',
                type: 'bytes32'
              },
              {
                internalType: 'uint256',
                name: 'totalOriginalConsiderationItems',
                type: 'uint256'
              }
            ],
            internalType: 'struct OrderParameters',
            name: 'parameters',
            type: 'tuple'
          },
          { internalType: 'uint120', name: 'numerator', type: 'uint120' },
          {
            internalType: 'uint120',
            name: 'denominator',
            type: 'uint120'
          },
          { internalType: 'bytes', name: 'signature', type: 'bytes' },
          { internalType: 'bytes', name: 'extraData', type: 'bytes' }
        ],
        internalType: 'struct AdvancedOrder[]',
        name: 'advancedOrders',
        type: 'tuple[]'
      },
      {
        components: [
          {
            internalType: 'uint256',
            name: 'orderIndex',
            type: 'uint256'
          },
          { internalType: 'enum Side', name: 'side', type: 'uint8' },
          { internalType: 'uint256', name: 'index', type: 'uint256' },
          {
            internalType: 'uint256',
            name: 'identifier',
            type: 'uint256'
          },
          {
            internalType: 'bytes32[]',
            name: 'criteriaProof',
            type: 'bytes32[]'
          }
        ],
        internalType: 'struct CriteriaResolver[]',
        name: 'criteriaResolvers',
        type: 'tuple[]'
      },
      {
        components: [
          {
            components: [
              {
                internalType: 'uint256',
                name: 'orderIndex',
                type: 'uint256'
              },
              {
                internalType: 'uint256',
                name: 'itemIndex',
                type: 'uint256'
              }
            ],
            internalType: 'struct FulfillmentComponent[]',
            name: 'offerComponents',
            type: 'tuple[]'
          },
          {
            components: [
              {
                internalType: 'uint256',
                name: 'orderIndex',
                type: 'uint256'
              },
              {
                internalType: 'uint256',
                name: 'itemIndex',
                type: 'uint256'
              }
            ],
            internalType: 'struct FulfillmentComponent[]',
            name: 'considerationComponents',
            type: 'tuple[]'
          }
        ],
        internalType: 'struct Fulfillment[]',
        name: 'fulfillments',
        type: 'tuple[]'
      }
    ],
    name: 'matchAdvancedOrders',
    outputs: [
      {
        components: [
          {
            components: [
              {
                internalType: 'enum ItemType',
                name: 'itemType',
                type: 'uint8'
              },
              { internalType: 'address', name: 'token', type: 'address' },
              {
                internalType: 'uint256',
                name: 'identifier',
                type: 'uint256'
              },
              {
                internalType: 'uint256',
                name: 'amount',
                type: 'uint256'
              },
              {
                internalType: 'address payable',
                name: 'recipient',
                type: 'address'
              }
            ],
            internalType: 'struct ReceivedItem',
            name: 'item',
            type: 'tuple'
          },
          { internalType: 'address', name: 'offerer', type: 'address' },
          { internalType: 'bytes32', name: 'conduitKey', type: 'bytes32' }
        ],
        internalType: 'struct Execution[]',
        name: 'executions',
        type: 'tuple[]'
      }
    ],
    stateMutability: 'payable',
    type: 'function'
  },
  {
    inputs: [
      {
        components: [
          {
            components: [
              {
                internalType: 'address',
                name: 'offerer',
                type: 'address'
              },
              { internalType: 'address', name: 'zone', type: 'address' },
              {
                components: [
                  {
                    internalType: 'enum ItemType',
                    name: 'itemType',
                    type: 'uint8'
                  },
                  {
                    internalType: 'address',
                    name: 'token',
                    type: 'address'
                  },
                  {
                    internalType: 'uint256',
                    name: 'identifierOrCriteria',
                    type: 'uint256'
                  },
                  {
                    internalType: 'uint256',
                    name: 'startAmount',
                    type: 'uint256'
                  },
                  {
                    internalType: 'uint256',
                    name: 'endAmount',
                    type: 'uint256'
                  }
                ],
                internalType: 'struct OfferItem[]',
                name: 'offer',
                type: 'tuple[]'
              },
              {
                components: [
                  {
                    internalType: 'enum ItemType',
                    name: 'itemType',
                    type: 'uint8'
                  },
                  {
                    internalType: 'address',
                    name: 'token',
                    type: 'address'
                  },
                  {
                    internalType: 'uint256',
                    name: 'identifierOrCriteria',
                    type: 'uint256'
                  },
                  {
                    internalType: 'uint256',
                    name: 'startAmount',
                    type: 'uint256'
                  },
                  {
                    internalType: 'uint256',
                    name: 'endAmount',
                    type: 'uint256'
                  },
                  {
                    internalType: 'address payable',
                    name: 'recipient',
                    type: 'address'
                  }
                ],
                internalType: 'struct ConsiderationItem[]',
                name: 'consideration',
                type: 'tuple[]'
              },
              {
                internalType: 'enum OrderType',
                name: 'orderType',
                type: 'uint8'
              },
              {
                internalType: 'uint256',
                name: 'startTime',
                type: 'uint256'
              },
              {
                internalType: 'uint256',
                name: 'endTime',
                type: 'uint256'
              },
              {
                internalType: 'bytes32',
                name: 'zoneHash',
                type: 'bytes32'
              },
              { internalType: 'uint256', name: 'salt', type: 'uint256' },
              {
                internalType: 'bytes32',
                name: 'conduitKey',
                type: 'bytes32'
              },
              {
                internalType: 'uint256',
                name: 'totalOriginalConsiderationItems',
                type: 'uint256'
              }
            ],
            internalType: 'struct OrderParameters',
            name: 'parameters',
            type: 'tuple'
          },
          { internalType: 'bytes', name: 'signature', type: 'bytes' }
        ],
        internalType: 'struct Order[]',
        name: 'orders',
        type: 'tuple[]'
      },
      {
        components: [
          {
            components: [
              {
                internalType: 'uint256',
                name: 'orderIndex',
                type: 'uint256'
              },
              {
                internalType: 'uint256',
                name: 'itemIndex',
                type: 'uint256'
              }
            ],
            internalType: 'struct FulfillmentComponent[]',
            name: 'offerComponents',
            type: 'tuple[]'
          },
          {
            components: [
              {
                internalType: 'uint256',
                name: 'orderIndex',
                type: 'uint256'
              },
              {
                internalType: 'uint256',
                name: 'itemIndex',
                type: 'uint256'
              }
            ],
            internalType: 'struct FulfillmentComponent[]',
            name: 'considerationComponents',
            type: 'tuple[]'
          }
        ],
        internalType: 'struct Fulfillment[]',
        name: 'fulfillments',
        type: 'tuple[]'
      }
    ],
    name: 'matchOrders',
    outputs: [
      {
        components: [
          {
            components: [
              {
                internalType: 'enum ItemType',
                name: 'itemType',
                type: 'uint8'
              },
              { internalType: 'address', name: 'token', type: 'address' },
              {
                internalType: 'uint256',
                name: 'identifier',
                type: 'uint256'
              },
              {
                internalType: 'uint256',
                name: 'amount',
                type: 'uint256'
              },
              {
                internalType: 'address payable',
                name: 'recipient',
                type: 'address'
              }
            ],
            internalType: 'struct ReceivedItem',
            name: 'item',
            type: 'tuple'
          },
          { internalType: 'address', name: 'offerer', type: 'address' },
          { internalType: 'bytes32', name: 'conduitKey', type: 'bytes32' }
        ],
        internalType: 'struct Execution[]',
        name: 'executions',
        type: 'tuple[]'
      }
    ],
    stateMutability: 'payable',
    type: 'function'
  },
  {
    inputs: [],
    name: 'name',
    outputs: [{ internalType: 'string', name: 'contractName', type: 'string' }],
    stateMutability: 'pure',
    type: 'function'
  },
  {
    inputs: [
      {
        components: [
          {
            components: [
              {
                internalType: 'address',
                name: 'offerer',
                type: 'address'
              },
              { internalType: 'address', name: 'zone', type: 'address' },
              {
                components: [
                  {
                    internalType: 'enum ItemType',
                    name: 'itemType',
                    type: 'uint8'
                  },
                  {
                    internalType: 'address',
                    name: 'token',
                    type: 'address'
                  },
                  {
                    internalType: 'uint256',
                    name: 'identifierOrCriteria',
                    type: 'uint256'
                  },
                  {
                    internalType: 'uint256',
                    name: 'startAmount',
                    type: 'uint256'
                  },
                  {
                    internalType: 'uint256',
                    name: 'endAmount',
                    type: 'uint256'
                  }
                ],
                internalType: 'struct OfferItem[]',
                name: 'offer',
                type: 'tuple[]'
              },
              {
                components: [
                  {
                    internalType: 'enum ItemType',
                    name: 'itemType',
                    type: 'uint8'
                  },
                  {
                    internalType: 'address',
                    name: 'token',
                    type: 'address'
                  },
                  {
                    internalType: 'uint256',
                    name: 'identifierOrCriteria',
                    type: 'uint256'
                  },
                  {
                    internalType: 'uint256',
                    name: 'startAmount',
                    type: 'uint256'
                  },
                  {
                    internalType: 'uint256',
                    name: 'endAmount',
                    type: 'uint256'
                  },
                  {
                    internalType: 'address payable',
                    name: 'recipient',
                    type: 'address'
                  }
                ],
                internalType: 'struct ConsiderationItem[]',
                name: 'consideration',
                type: 'tuple[]'
              },
              {
                internalType: 'enum OrderType',
                name: 'orderType',
                type: 'uint8'
              },
              {
                internalType: 'uint256',
                name: 'startTime',
                type: 'uint256'
              },
              {
                internalType: 'uint256',
                name: 'endTime',
                type: 'uint256'
              },
              {
                internalType: 'bytes32',
                name: 'zoneHash',
                type: 'bytes32'
              },
              { internalType: 'uint256', name: 'salt', type: 'uint256' },
              {
                internalType: 'bytes32',
                name: 'conduitKey',
                type: 'bytes32'
              },
              {
                internalType: 'uint256',
                name: 'totalOriginalConsiderationItems',
                type: 'uint256'
              }
            ],
            internalType: 'struct OrderParameters',
            name: 'parameters',
            type: 'tuple'
          },
          { internalType: 'bytes', name: 'signature', type: 'bytes' }
        ],
        internalType: 'struct Order[]',
        name: 'orders',
        type: 'tuple[]'
      }
    ],
    name: 'validate',
    outputs: [{ internalType: 'bool', name: 'validated', type: 'bool' }],
    stateMutability: 'nonpayable',
    type: 'function'
  }
]);
