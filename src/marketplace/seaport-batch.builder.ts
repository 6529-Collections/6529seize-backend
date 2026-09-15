import { AbiCoder, Interface } from 'ethers';
import {
  MarketAdvancedOrder,
  MarketBatchFulfillment,
  MarketBatchFulfillmentMaterial,
  MarketBatchIntent,
  MarketBatchMirrorTerms
} from '@/marketplace/market-batch.types';
import {
  MarketTransaction,
  SeaportConsiderationItem,
  ValidatedMarketOrder
} from '@/marketplace/provider.types';
import { MARKET_BATCH_LIMITS } from '@/marketplace/market-batch.schema';
import {
  rejectMarketBatch,
  validateMarketBatchMaterials
} from '@/marketplace/market-batch-validation';
import {
  MARKET_SEAPORT,
  MARKET_ZERO_ADDRESS,
  MARKET_ZERO_HASH
} from '@/marketplace/seaport.registry';
import { SEAPORT_PARAMETERS_TUPLE } from '@/marketplace/seaport.schema';
import { sameMarketAddress } from '@/marketplace/quote-validation';
import { assertMarketBatchFlowLedger } from '@/marketplace/market-batch-flow-ledger';

const ADVANCED_TUPLE = `(${SEAPORT_PARAMETERS_TUPLE} parameters,uint120 numerator,uint120 denominator,bytes signature,bytes extraData)`;
const FULFILLMENT_TUPLE =
  '((uint256 orderIndex,uint256 itemIndex)[] offerComponents,(uint256 orderIndex,uint256 itemIndex)[] considerationComponents)';
export const MARKET_BATCH_INTERFACE = new Interface([
  `function matchAdvancedOrders(${ADVANCED_TUPLE}[] orders,(uint256 orderIndex,uint8 side,uint256 index,uint256 identifier,bytes32[] criteriaProof)[] criteriaResolvers,${FULFILLMENT_TUPLE}[] fulfillments,address recipient) payable`
]);
const coder = AbiCoder.defaultAbiCoder();

function fraction(quantity: string, original: string): [string, string] {
  let a = BigInt(quantity),
    b = BigInt(original);
  while (b !== BigInt(0)) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  const numerator = BigInt(quantity) / a;
  const denominator = BigInt(original) / a;
  if (denominator > BigInt('0xffffffffffffffffffffffffffffff'))
    rejectMarketBatch('The exact fill fraction exceeds the Seaport limit.');
  return [numerator.toString(), denominator.toString()];
}

function sellerOrders(
  intent: MarketBatchIntent,
  materials: MarketBatchFulfillmentMaterial[],
  orders: ValidatedMarketOrder[]
): MarketAdvancedOrder[] {
  return orders.map((order, index) => {
    const { counter: _counter, ...parameters } = order.components;
    const [numerator, denominator] = fraction(
      intent.items[index].intent.quantity,
      parameters.offer[0].startAmount
    );
    return {
      parameters: {
        ...parameters,
        totalOriginalConsiderationItems: parameters.consideration.length
      },
      numerator,
      denominator,
      signature: materials[index].signature,
      extraData: materials[index].extraData
    };
  });
}

function buyerMirror(
  intent: MarketBatchIntent,
  terms: MarketBatchMirrorTerms
): MarketAdvancedOrder {
  const consideration: SeaportConsiderationItem[] = intent.items.flatMap(
    (line) =>
      line.allocations.map((allocation) => ({
        itemType: line.intent.asset.standard === 'ERC721' ? 2 : 3,
        token: line.intent.asset.contract,
        identifierOrCriteria: line.intent.asset.tokenId,
        startAmount: allocation.quantity,
        endAmount: allocation.quantity,
        recipient: allocation.recipient
      }))
  );
  return {
    parameters: {
      offerer: intent.wallet,
      zone: MARKET_ZERO_ADDRESS,
      offer: [
        {
          itemType: 0,
          token: MARKET_ZERO_ADDRESS,
          identifierOrCriteria: '0',
          startAmount: intent.totalWei,
          endAmount: intent.totalWei
        }
      ],
      consideration,
      orderType: 0,
      ...terms,
      zoneHash: MARKET_ZERO_HASH,
      conduitKey: MARKET_ZERO_HASH,
      totalOriginalConsiderationItems: consideration.length
    },
    numerator: '1',
    denominator: '1',
    signature: '0x',
    extraData: '0x'
  };
}

function mapping(
  intent: MarketBatchIntent,
  orders: ValidatedMarketOrder[]
): MarketBatchFulfillment[] {
  const mirror = intent.items.length;
  let recipientIndex = 0;
  const fulfillments: MarketBatchFulfillment[] = [];
  intent.items.forEach((line, orderIndex) => {
    for (const _allocation of line.allocations) {
      fulfillments.push({
        offerComponents: [{ orderIndex, itemIndex: 0 }],
        considerationComponents: [
          { orderIndex: mirror, itemIndex: recipientIndex++ }
        ]
      });
    }
  });
  orders.forEach((order, orderIndex) => {
    order.components.consideration.forEach((_item, itemIndex) => {
      fulfillments.push({
        offerComponents: [{ orderIndex: mirror, itemIndex: 0 }],
        considerationComponents: [{ orderIndex, itemIndex }]
      });
    });
  });
  return fulfillments;
}

/** One unsigned payer mirror consumes every selected NFT and every exact payment. */
export function buildMarketBatchTransaction(
  intent: MarketBatchIntent,
  materials: MarketBatchFulfillmentMaterial[],
  terms: MarketBatchMirrorTerms
): MarketTransaction {
  const checked = validateMarketBatchMaterials(intent, materials, terms);
  const orders = [
    ...sellerOrders(intent, materials, checked),
    buyerMirror(intent, terms)
  ];
  const data = MARKET_BATCH_INTERFACE.encodeFunctionData(
    'matchAdvancedOrders',
    [orders, [], mapping(intent, checked), intent.wallet]
  );
  if ((data.length - 2) / 2 > MARKET_BATCH_LIMITS.max_calldata_bytes)
    rejectMarketBatch('The selected batch exceeds the transaction data limit.');
  return {
    kind: 'TRANSACTION',
    chainId: 1,
    from: intent.wallet,
    to: MARKET_SEAPORT,
    value: intent.totalWei,
    data,
    purpose: 'FULFILL'
  };
}

/** Reconstruct expected orders and flows from reviewed intent, not incoming calldata. */
export function validateMarketBatchTransaction(
  intent: MarketBatchIntent,
  materials: MarketBatchFulfillmentMaterial[],
  terms: MarketBatchMirrorTerms,
  transaction: MarketTransaction
): void {
  const checked = validateMarketBatchMaterials(intent, materials, terms);
  if (
    transaction.kind !== 'TRANSACTION' ||
    transaction.chainId !== 1 ||
    transaction.purpose !== 'FULFILL' ||
    transaction.approvalScope !== undefined ||
    !sameMarketAddress(transaction.from, intent.wallet) ||
    !sameMarketAddress(transaction.to, MARKET_SEAPORT) ||
    transaction.value !== intent.totalWei ||
    !/^0x(?:[\da-fA-F]{2})*$/.test(transaction.data) ||
    (transaction.data.length - 2) / 2 > MARKET_BATCH_LIMITS.max_calldata_bytes
  )
    rejectMarketBatch('The batch transaction envelope changed.');
  try {
    const decoded = MARKET_BATCH_INTERFACE.decodeFunctionData(
      'matchAdvancedOrders',
      transaction.data
    );
    if (
      decoded.orders.length !== checked.length + 1 ||
      decoded.criteriaResolvers.length !== 0 ||
      !sameMarketAddress(decoded.recipient, intent.wallet)
    )
      rejectMarketBatch(
        'The batch order count, criteria or residual recipient changed.'
      );
    assertMarketBatchFlowLedger(
      intent,
      checked,
      decoded.orders,
      decoded.fulfillments
    );
    const expected = [
      ...sellerOrders(intent, materials, checked),
      buyerMirror(intent, terms)
    ];
    expected.forEach((order, index) => {
      if (
        coder.encode([ADVANCED_TUPLE], [decoded.orders[index]]) !==
        coder.encode([ADVANCED_TUPLE], [order])
      )
        rejectMarketBatch(
          'A seller authorization or buyer allocation changed.'
        );
    });
    if (
      coder.encode([`${FULFILLMENT_TUPLE}[]`], [decoded.fulfillments]) !==
      coder.encode([`${FULFILLMENT_TUPLE}[]`], [mapping(intent, checked)])
    )
      rejectMarketBatch(
        'Every NFT allocation and payment must have exactly its reviewed mapping.'
      );
    // Reject appended bytes and noncanonical ABI offsets as well as semantic changes.
    const canonical = MARKET_BATCH_INTERFACE.encodeFunctionData(
      'matchAdvancedOrders',
      Array.from(decoded)
    );
    if (canonical.toLowerCase() !== transaction.data.toLowerCase())
      rejectMarketBatch('The batch calldata is not canonical.');
  } catch {
    rejectMarketBatch(
      'The transaction does not match the complete reviewed batch.'
    );
  }
}
