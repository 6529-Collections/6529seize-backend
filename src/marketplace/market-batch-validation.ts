import { z } from 'zod';
import {
  MarketBatchFulfillmentMaterial,
  MarketBatchIntent,
  MarketBatchMirrorTerms
} from '@/marketplace/market-batch.types';
import {
  MARKET_BATCH_LIMITS,
  marketBatchPrepareSchema
} from '@/marketplace/market-batch.schema';
import {
  MarketValidationError,
  ValidatedMarketOrder
} from '@/marketplace/provider.types';
import {
  MARKET_OPENSEA_ZONE,
  MARKET_ZERO_ADDRESS,
  MARKET_ZERO_HASH,
  marketSpender
} from '@/marketplace/seaport.registry';
import {
  marketBytesSchema,
  marketUintSchema,
  parseMarketValue
} from '@/marketplace/seaport.schema';
import {
  assertMarketIntent,
  sameMarketAddress,
  validateMarketOrder
} from '@/marketplace/quote-validation';

export function rejectMarketBatch(message: string): never {
  throw new MarketValidationError('ORDER_MISMATCH', message);
}

/** Revalidate server-owned intent before encoding or accepting any transaction. */
export function assertMarketBatchIntent(intent: MarketBatchIntent): void {
  if (intent.kind !== 'BUY_BATCH' || intent.chainId !== 1)
    rejectMarketBatch('Unsupported batch action or chain.');
  parseMarketValue(marketBatchPrepareSchema, {
    kind: intent.kind,
    profile_id: 'validated-profile',
    wallet: intent.wallet,
    currency: intent.currency,
    execution_policy: intent.executionPolicy,
    amount_wei: intent.totalWei,
    items: intent.items.map((line) => ({
      asset_key: line.assetKey,
      order: {
        protocol_address: line.intent.order?.protocolAddress,
        order_hash: line.intent.order?.orderHash
      },
      quantity: line.intent.quantity,
      amount_wei: line.intent.maxTotalWei,
      allocations: line.allocations.map((allocation) => ({
        recipient: allocation.recipient,
        quantity: allocation.quantity,
        acknowledge_external_recipient: allocation.acknowledgeExternalRecipient
      }))
    }))
  });
  const unique721 = new Set<string>();
  for (const line of intent.items) {
    const item = assertMarketIntent(line.intent);
    if (
      line.assetKey !==
      `1:${item.asset.contract.toLowerCase()}:${item.asset.tokenId}`
    )
      rejectMarketBatch(
        'The displayed artwork key must match the exact purchased token.'
      );
    if (
      item.kind !== 'BUY' ||
      !sameMarketAddress(item.wallet, intent.wallet) ||
      !sameMarketAddress(item.currency, MARKET_ZERO_ADDRESS) ||
      !sameMarketAddress(item.recipient, line.allocations[0].recipient) ||
      item.includeOptionalCreatorFees
    )
      rejectMarketBatch(
        'Batch lines must retain the exact native ETH purchase intent.'
      );
    if (
      line.allocations.some(
        (allocation) =>
          typeof allocation.recipientInProfile !== 'boolean' ||
          (!allocation.recipientInProfile &&
            !allocation.acknowledgeExternalRecipient)
      )
    )
      rejectMarketBatch(
        'Every external recipient requires explicit acknowledgement.'
      );
    if (item.asset.standard === 'ERC721') {
      const key = `${item.asset.contract.toLowerCase()}:${item.asset.tokenId}`;
      if (unique721.has(key))
        rejectMarketBatch(
          'The same ERC721 cannot be purchased from multiple orders.'
        );
      unique721.add(key);
    }
  }
}

/** Current deployed SignedZone has context-specific bindings, not generic SIP support. */
export function validateMarketBatchZoneAuthorization(
  extraData: string,
  wallet: string,
  mirrorEndTime: string
): void {
  parseMarketValue(marketBytesSchema, extraData);
  const bytes = Buffer.from(extraData.slice(2), 'hex');
  if (bytes.length < 126 || bytes[0] !== 0)
    rejectMarketBatch('Unsupported SignedZone authorization encoding.');
  const context = bytes[93];
  const length =
    context === 0 || context === 1 ? 126 : context === 7 ? 166 : 146;
  if (![0, 1, 7, 8, 9].includes(context) || bytes.length !== length)
    rejectMarketBatch('Unsupported SignedZone authorization context.');
  const fulfiller = `0x${bytes.subarray(1, 21).toString('hex')}`;
  const expiry = BigInt(`0x${bytes.subarray(21, 29).toString('hex')}`);
  if (
    (!sameMarketAddress(fulfiller, wallet) &&
      fulfiller !== MARKET_ZERO_ADDRESS) ||
    expiry < BigInt(mirrorEndTime) ||
    `0x${bytes.subarray(94, 126).toString('hex')}` !== MARKET_ZERO_HASH
  )
    rejectMarketBatch(
      'SignedZone payer, expiry or native payment binding changed.'
    );
  // The zone signature and any registry/operator restrictions must also pass
  // the exact complete transaction's chain simulation before REVIEW.
}

export function validateMarketBatchMaterials(
  intent: MarketBatchIntent,
  materials: MarketBatchFulfillmentMaterial[],
  terms: MarketBatchMirrorTerms
): ValidatedMarketOrder[] {
  assertMarketBatchIntent(intent);
  parseMarketValue(
    z
      .object({
        startTime: marketUintSchema,
        endTime: marketUintSchema,
        salt: marketUintSchema
      })
      .strict(),
    terms
  );
  if (BigInt(terms.startTime) >= BigInt(terms.endTime))
    rejectMarketBatch('The buyer order requires a valid bounded interval.');
  if (
    materials.length !== intent.items.length ||
    materials.length > MARKET_BATCH_LIMITS.max_orders
  )
    rejectMarketBatch(
      'Every selected order requires its own exact authorization.'
    );
  return materials.map((material, index) => {
    const line = intent.items[index];
    const order = validateMarketOrder(
      line.intent,
      material.order.components,
      material.order.protocolAddress
    );
    if (
      order.orderHash.toLowerCase() !==
        material.order.orderHash.toLowerCase() ||
      order.digest.toLowerCase() !== material.order.digest.toLowerCase() ||
      order.totalWei !== line.intent.maxTotalWei ||
      sameMarketAddress(order.components.offerer, intent.wallet) ||
      BigInt(order.components.startTime) > BigInt(terms.startTime) ||
      BigInt(order.components.endTime) < BigInt(terms.endTime)
    )
      rejectMarketBatch('The selected order, exact cost or validity changed.');
    parseMarketValue(marketBytesSchema, material.signature);
    parseMarketValue(marketBytesSchema, material.extraData);
    marketSpender(material.fulfillerConduitKey);
    if (sameMarketAddress(order.components.zone, MARKET_OPENSEA_ZONE)) {
      // Fresh provider proof currently covers restricted ERC1155 quantity one.
      // Do not claim restricted multi-edition/partial compatibility from open-order tests.
      if (
        line.intent.asset.standard === 'ERC1155' &&
        (order.components.offer[0].startAmount !== '1' ||
          line.intent.quantity !== '1')
      )
        throw new MarketValidationError(
          'UNSUPPORTED_ACTION',
          'Restricted multi-edition orders are not supported in one batch yet.'
        );
      validateMarketBatchZoneAuthorization(
        material.extraData,
        intent.wallet,
        terms.endTime
      );
    } else if (material.extraData !== '0x') {
      rejectMarketBatch('Open orders cannot include zone authorization.');
    }
    return order;
  });
}
