import {
  concat,
  Interface,
  keccak256,
  solidityPackedKeccak256,
  toBeHex
} from 'ethers';
import type { MarketTradeIntent } from '@/marketplace/provider.types';
import type { MarketPrepared } from '@/marketplace/market-preparation';
import { validateMarketCriteria } from '@/marketplace/seaport-criteria';
import { validateMarketOrder } from '@/marketplace/quote-validation';
import {
  buildMarketFulfillment,
  buildMarketOrder,
  MARKET_SEAPORT_INTERFACE
} from '@/marketplace/seaport.builder';
import {
  MARKET_OPENSEA_CONDUIT_KEY,
  MARKET_SEAPORT,
  MARKET_WETH,
  MARKET_ZERO_HASH
} from '@/marketplace/seaport.registry';
import { MARKET_SEAPORT_EVENTS } from '@/marketplace/seaport.events';
import {
  MarketReceiptEvidence,
  validateMarketReceipt
} from '@/marketplace/market-reconciliation';

const maker = '0x1111111111111111111111111111111111111111';
const seller = '0x2222222222222222222222222222222222222222';
const fee = '0x3333333333333333333333333333333333333333';
const contract = '0x33fd426905f149f8376e227d0c9d3340aad17af1';
const gradient = '0x0c58ef43ff3032005e472cb5709f8908acb00205';
const leaf = (id: string) => solidityPackedKeccak256(['uint256'], [id]);
const pair = (left: string, right: string) =>
  keccak256(concat([left, right].sort((a, b) => a.localeCompare(b))));

function fixture(root = '0', standard: 'ERC721' | 'ERC1155' = 'ERC1155') {
  const quantity = standard === 'ERC1155' ? '3' : '1';
  const offer: MarketTradeIntent = {
    kind: 'OFFER',
    chainId: 1,
    wallet: maker,
    recipient: maker,
    asset: {
      contract: standard === 'ERC1155' ? contract : gradient,
      standard,
      tokenId: '56'
    },
    quantity,
    currency: MARKET_WETH,
    maxTotalWei: (BigInt(quantity) * BigInt(100)).toString(),
    minNetWei: (BigInt(quantity) * BigInt(99)).toString(),
    fees: [{ recipient: fee, amountWei: quantity }],
    includeOptionalCreatorFees: false,
    startTime: '1700000000',
    endTime: '1900000000'
  };
  const components = buildMarketOrder(offer, '4', '5').order.components;
  components.orderType = 3;
  components.consideration[0].itemType = standard === 'ERC1155' ? 5 : 4;
  components.consideration[0].identifierOrCriteria = root;
  const unbound: MarketTradeIntent = {
    ...offer,
    kind: 'ACCEPT',
    wallet: seller,
    recipient: seller
  };
  const reviewed = validateMarketOrder(unbound, components);
  const intent: MarketTradeIntent = {
    ...unbound,
    order: { orderHash: reviewed.orderHash, protocolAddress: MARKET_SEAPORT }
  };
  const resolver = {
    orderIndex: '0',
    side: 1 as const,
    index: '0',
    identifier: '56',
    criteriaProof: [] as string[]
  };
  return { intent, components, reviewed, resolver };
}

describe('Seaport criteria binding for an exact page NFT', () => {
  it.each(['ERC721', 'ERC1155'] as const)(
    'resolves a collection-wide %s offer without changing its signed root or hash',
    (standard) => {
      const value = fixture('0', standard);
      const before = JSON.stringify(value.components);
      expect(
        validateMarketCriteria(value.intent, value.components, [value.resolver])
      ).toEqual([value.resolver]);
      const tx = buildMarketFulfillment(
        value.intent,
        value.reviewed,
        '0x1234',
        '0xabcd',
        MARKET_OPENSEA_CONDUIT_KEY,
        [value.resolver]
      );
      const decoded = MARKET_SEAPORT_INTERFACE.decodeFunctionData(
        'fulfillAdvancedOrder',
        tx.data
      );
      expect(decoded.criteriaResolvers[0].identifier.toString()).toBe('56');
      expect(
        decoded.advancedOrder.parameters.consideration[0].identifierOrCriteria.toString()
      ).toBe('0');
      expect(decoded.recipient.toLowerCase()).toBe(seller);
      expect(JSON.stringify(value.components)).toBe(before);
      expect(
        validateMarketOrder(value.intent, value.components).orderHash
      ).toBe(value.reviewed.orderHash);
    }
  );

  it('accepts a singleton Merkle root with its empty proof, using one hash of the 32-byte ID', () => {
    expect(leaf('0')).toBe(
      '0x290decd9548b62a8d60345a988386fc84ba6bc95484008f6362f93160ef3e563'
    );
    const value = fixture(BigInt(leaf('56')).toString());
    expect(
      validateMarketCriteria(value.intent, value.components, [value.resolver])
    ).toEqual([value.resolver]);
  });

  it('keeps a uint256 token identifier exact beyond JavaScript number precision', () => {
    const identifier = ((BigInt(1) << BigInt(255)) + BigInt(56)).toString();
    const value = fixture(BigInt(leaf(identifier)).toString());
    value.intent.asset.tokenId = identifier;
    value.resolver.identifier = identifier;
    expect(
      validateMarketCriteria(value.intent, value.components, [
        value.resolver
      ])[0].identifier
    ).toBe(identifier);
  });

  it.each(['0', '57'])(
    'accepts a sorted sibling on either side of token %s',
    (other) => {
      const sibling = leaf(other);
      expect(BigInt(sibling) < BigInt(leaf('56'))).toBe(other === '0');
      const value = fixture(BigInt(pair(leaf('56'), sibling)).toString());
      value.resolver.criteriaProof = [sibling];
      expect(
        validateMarketCriteria(value.intent, value.components, [value.resolver])
      ).toEqual([value.resolver]);
    }
  );

  it('verifies every node of a multi-level inclusion proof', () => {
    const sibling = leaf('57'),
      branch = pair(leaf('58'), leaf('59'));
    const value = fixture(
      BigInt(pair(pair(leaf('56'), sibling), branch)).toString()
    );
    value.resolver.criteriaProof = [sibling, branch];
    expect(
      validateMarketCriteria(value.intent, value.components, [value.resolver])
    ).toHaveLength(1);
    expect(() =>
      validateMarketCriteria(value.intent, value.components, [
        { ...value.resolver, criteriaProof: [branch, sibling] }
      ])
    ).toThrow();
  });

  it.each(['raw-id', 'double-hashed', 'another-token', 'another-root'])(
    'rejects a %s root',
    (kind) => {
      const roots = {
        'raw-id': '56',
        'double-hashed': BigInt(keccak256(leaf('56'))).toString(),
        'another-token': BigInt(leaf('57')).toString(),
        'another-root': '123'
      };
      const value = fixture(roots[kind as keyof typeof roots]);
      expect(() =>
        validateMarketCriteria(value.intent, value.components, [value.resolver])
      ).toThrow(/criteria/);
    }
  );

  it.each([
    { orderIndex: '1' },
    { index: '1' },
    { side: 0 },
    { side: '1' },
    { identifier: '57' },
    { identifier: '056' },
    { identifier: Number.MAX_SAFE_INTEGER + 1 },
    { criteriaProof: [MARKET_ZERO_HASH] },
    { criteriaProof: ['0xab'] },
    { extra: true }
  ])('rejects an altered or noncanonical resolver %j', (change) => {
    const value = fixture();
    expect(() =>
      validateMarketCriteria(value.intent, value.components, [
        { ...value.resolver, ...change }
      ])
    ).toThrow();
  });

  it('accepts safe numeric indexes but rejects missing and extra resolvers', () => {
    const value = fixture();
    expect(
      validateMarketCriteria(value.intent, value.components, [
        { ...value.resolver, orderIndex: 0, index: 0, identifier: 56 }
      ])
    ).toEqual([value.resolver]);
    for (const resolvers of [[], [value.resolver, value.resolver], undefined])
      expect(() =>
        validateMarketCriteria(value.intent, value.components, resolvers)
      ).toThrow();
  });

  it('rejects a proof longer than the explicit parser bound', () => {
    const value = fixture(BigInt(leaf('56')).toString());
    expect(() =>
      validateMarketCriteria(value.intent, value.components, [
        {
          ...value.resolver,
          criteriaProof: Array.from({ length: 33 }, () => MARKET_ZERO_HASH)
        }
      ])
    ).toThrow();
  });

  it.each(['standard', 'contract', 'signing-kind', 'extra-nft', 'fee-item'])(
    'keeps the exact NFT and payment boundary for changed %s',
    (change) => {
      const value = fixture();
      if (change === 'standard') value.components.consideration[0].itemType = 4;
      if (change === 'contract')
        value.components.consideration[0].token = gradient;
      if (change === 'signing-kind') {
        value.intent.kind = 'OFFER';
        value.intent.wallet = maker;
        value.intent.recipient = maker;
      }
      if (change === 'extra-nft')
        value.components.consideration.push({
          ...value.components.consideration[0]
        });
      if (change === 'fee-item') value.components.consideration[1].itemType = 5;
      expect(() =>
        validateMarketOrder(value.intent, value.components)
      ).toThrow();
    }
  );

  it('does not allow resolvers on an exact-token offer', () => {
    const value = fixture();
    value.components.consideration[0].itemType = 3;
    value.components.consideration[0].identifierOrCriteria = '56';
    expect(validateMarketCriteria(value.intent, value.components, [])).toEqual(
      []
    );
    expect(() =>
      validateMarketCriteria(value.intent, value.components, [value.resolver])
    ).toThrow();
  });

  it('binds the original signed criteria root rather than substituting the page token into the order', () => {
    const value = fixture(BigInt(leaf('56')).toString());
    value.components.consideration[0].identifierOrCriteria = '0';
    expect(() => validateMarketOrder(value.intent, value.components)).toThrow(
      /hash/
    );
  });

  it('supports only fee-exact partial ERC1155 fills and preserves numerator/denominator', () => {
    const value = fixture();
    const partial: MarketTradeIntent = {
      ...value.intent,
      quantity: '1',
      maxTotalWei: '100',
      minNetWei: '99',
      fees: [{ recipient: fee, amountWei: '1' }]
    };
    const reviewed = validateMarketOrder(partial, value.components);
    const tx = buildMarketFulfillment(
      partial,
      reviewed,
      '0x1234',
      '0xabcd',
      MARKET_OPENSEA_CONDUIT_KEY,
      [value.resolver]
    );
    const decoded = MARKET_SEAPORT_INTERFACE.decodeFunctionData(
      'fulfillAdvancedOrder',
      tx.data
    );
    expect(decoded.advancedOrder.numerator.toString()).toBe('1');
    expect(decoded.advancedOrder.denominator.toString()).toBe('3');
    const indivisible = structuredClone(value.components);
    indivisible.consideration[1].startAmount =
      indivisible.consideration[1].endAmount = '4';
    expect(() =>
      validateMarketOrder({ ...partial, order: undefined }, indivisible)
    ).toThrow(/round/);
    const whole = { ...value.components, orderType: 2 };
    expect(() =>
      validateMarketOrder({ ...partial, order: undefined }, whole)
    ).toThrow(/quantity/);
  });
});

function settlement(tokenId = '56', transferId = '56', eventType = 3) {
  const value = fixture(BigInt(leaf('56')).toString());
  const intent: MarketTradeIntent = {
    ...value.intent,
    quantity: '1',
    maxTotalWei: '100',
    minNetWei: '99',
    fees: [{ recipient: fee, amountWei: '1' }]
  };
  const reviewed = validateMarketOrder(intent, value.components);
  const transaction = buildMarketFulfillment(
    intent,
    reviewed,
    '0x1234',
    '0xabcd',
    MARKET_OPENSEA_CONDUIT_KEY,
    [value.resolver]
  );
  const hash = toBeHex(1, 32),
    blockHash = toBeHex(2, 32);
  const prepared: MarketPrepared = {
    intent,
    recipientInProfile: true,
    approvalTransactions: [],
    transaction,
    reviewOrder: reviewed,
    snapshot: {
      block_number: 1,
      block_hash: blockHash,
      block_timestamp: 1800000000
    },
    feePolicyVersion: MARKET_ZERO_HASH
  };
  const fill = MARKET_SEAPORT_EVENTS.encodeEventLog(
    MARKET_SEAPORT_EVENTS.getEvent('OrderFulfilled')!,
    [
      reviewed.orderHash,
      maker,
      value.components.zone,
      seller,
      [[1, MARKET_WETH, '0', '100']],
      [
        [eventType, contract, tokenId, '1', maker],
        [1, MARKET_WETH, '0', '1', fee]
      ]
    ]
  );
  const token = new Interface([
    'event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)'
  ]);
  const transfer = token.encodeEventLog(token.getEvent('TransferSingle')!, [
    MARKET_SEAPORT,
    seller,
    maker,
    transferId,
    '1'
  ]);
  const receipt: MarketReceiptEvidence = {
    hash,
    blockNumber: 2,
    blockHash,
    status: 1,
    logs: [
      { address: MARKET_SEAPORT, ...fill },
      { address: contract, ...transfer }
    ]
  };
  const submitted = {
    hash,
    from: seller,
    to: MARKET_SEAPORT,
    data: transaction.data,
    value: BigInt(0),
    chainId: BigInt(1)
  };
  return { prepared, receipt, submitted };
}

describe('criteria-offer receipt proves the resolved NFT', () => {
  it('accepts the original order hash with resolved type/token and exact actual NFT transfer', () => {
    const value = settlement();
    expect(
      validateMarketReceipt(
        value.prepared,
        'ACCEPT',
        value.submitted,
        value.receipt
      )
    ).toMatchObject({ filledQuantity: '1', remainingQuantity: '0' });
  });
  it.each([
    ['57', '56', 3],
    ['56', '57', 3],
    [BigInt(leaf('56')).toString(), '56', 5]
  ] as const)(
    'rejects wrong event ID %s / actual transfer %s / unresolved type %s',
    (id, transfer, type) => {
      const value = settlement(id, transfer, type);
      expect(() =>
        validateMarketReceipt(
          value.prepared,
          'ACCEPT',
          value.submitted,
          value.receipt
        )
      ).toThrow();
    }
  );
  it('rejects missing actual NFT transfer, changed calldata, and changed proceeds value', () => {
    const value = settlement();
    expect(() =>
      validateMarketReceipt(value.prepared, 'ACCEPT', value.submitted, {
        ...value.receipt,
        logs: value.receipt.logs.slice(0, 1)
      })
    ).toThrow();
    expect(() =>
      validateMarketReceipt(
        value.prepared,
        'ACCEPT',
        { ...value.submitted, data: '0x1234' },
        value.receipt
      )
    ).toThrow();
    expect(() =>
      validateMarketReceipt(
        value.prepared,
        'ACCEPT',
        { ...value.submitted, value: BigInt(1) },
        value.receipt
      )
    ).toThrow();
  });
});
