import { randomBytes } from 'node:crypto';
import { simulateMarketBatch } from '@/marketplace/market-batch-simulation';
import { collectingService } from '@/collecting/collecting.service';
import { CollectingAsset } from '@/collecting/collecting.types';
import { MarketChain } from '@/marketplace/market-chain';
import {
  OpenSeaMarketplaceProvider,
  describeMarketOrder
} from '@/marketplace/provider.opensea';
import {
  MarketTradeIntent,
  MarketValidationError
} from '@/marketplace/provider.types';
import {
  MarketBatchPrepareRequest,
  marketBatchPrepareSchema
} from '@/marketplace/market-batch.schema';
import {
  MarketBatchFulfillmentMaterial,
  MarketBatchIntent,
  MarketBatchLine,
  MarketBatchPrepared
} from '@/marketplace/market-batch.types';
import { MARKET_SEAPORT_INTERFACE } from '@/marketplace/seaport.builder';
import {
  MARKET_SEAPORT,
  MARKET_ZERO_ADDRESS
} from '@/marketplace/seaport.registry';
import {
  sameMarketAddress,
  validateMarketOrder
} from '@/marketplace/quote-validation';
import {
  buildMarketBatchTransaction,
  validateMarketBatchTransaction
} from '@/marketplace/seaport-batch.builder';
import {
  assertMarketBatchActive,
  mapMarketBatch
} from '@/marketplace/market-batch-deadline';

function unavailable(message: string): never {
  throw new MarketValidationError('ORDER_MISMATCH', message);
}

/** The existing provider's strict single-order adapter remains the authorization boundary. */
async function prepareLine(
  request: MarketBatchPrepareRequest['items'][number],
  wallet: string,
  wallets: Set<string>,
  asset: CollectingAsset,
  provider: OpenSeaMarketplaceProvider,
  chain: MarketChain,
  signal: AbortSignal
): Promise<{
  line: MarketBatchLine;
  material: MarketBatchFulfillmentMaterial;
}> {
  const intent: MarketTradeIntent = {
    kind: 'BUY',
    chainId: 1,
    wallet,
    recipient: request.allocations[0].recipient,
    asset: {
      contract: asset.contract,
      tokenId: asset.token_id,
      standard: asset.family === 'memes' ? 'ERC1155' : 'ERC721'
    },
    quantity: request.quantity,
    currency: MARKET_ZERO_ADDRESS,
    maxTotalWei: request.amount_wei,
    minNetWei: request.amount_wei,
    fees: [],
    includeOptionalCreatorFees: false,
    order: {
      protocolAddress: request.order.protocol_address,
      orderHash: request.order.order_hash
    }
  };
  const selected = await provider.getOrder(intent.order!);
  assertMarketBatchActive(signal);
  const economics = describeMarketOrder(
    selected,
    intent.asset,
    'LISTING',
    request.quantity
  );
  if (
    economics.currency.toLowerCase() !== MARKET_ZERO_ADDRESS ||
    economics.totalWei !== request.amount_wei
  )
    unavailable(
      'A selected order price changed. Review this exact selection again.'
    );
  intent.minNetWei = economics.netWei;
  intent.fees = economics.fees;
  const [counter, status] = await Promise.all([
    chain.counter(selected.components.offerer),
    chain.orderStatus(request.order.order_hash)
  ]);
  if (
    status.cancelled ||
    (status.size > BigInt(0) &&
      BigInt(selected.components.offer[0].startAmount) *
        (status.size - status.filled) <
        BigInt(request.quantity) * status.size)
  )
    unavailable(
      'A selected order no longer has the complete requested quantity.'
    );
  assertMarketBatchActive(signal);
  const single = await provider.prepareFulfillment(intent, counter, selected);
  assertMarketBatchActive(signal);
  if (
    single.chainId !== 1 ||
    !sameMarketAddress(single.to, MARKET_SEAPORT) ||
    !sameMarketAddress(single.from, wallet) ||
    single.value !== request.amount_wei
  )
    unavailable(
      'The selected fulfillment changed its payer, protocol or exact value.'
    );
  const decoded = MARKET_SEAPORT_INTERFACE.decodeFunctionData(
    'fulfillAdvancedOrder',
    single.data
  );
  const order = validateMarketOrder(
    intent,
    selected.components,
    selected.identity.protocolAddress
  );
  if (
    decoded.criteriaResolvers.length ||
    !sameMarketAddress(decoded.recipient, intent.recipient)
  )
    unavailable('The selected fulfillment changed its recipient or criteria.');
  return {
    line: {
      assetKey: request.asset_key,
      intent,
      allocations: request.allocations.map((allocation) => ({
        recipient: allocation.recipient,
        quantity: allocation.quantity,
        recipientInProfile: wallets.has(allocation.recipient),
        acknowledgeExternalRecipient: allocation.acknowledge_external_recipient
      }))
    },
    material: {
      order,
      signature: decoded.advancedOrder.signature as string,
      extraData: decoded.advancedOrder.extraData as string,
      fulfillerConduitKey: decoded.fulfillerConduitKey as string
    }
  };
}

function authorizationEnd(material: MarketBatchFulfillmentMaterial): number {
  const sellerEnd = Number(material.order.components.endTime);
  if (material.extraData === '0x') return sellerEnd;
  // Full structural/binding validation follows before encoding; fail closed on malformed bytes.
  if (!/^0x[\da-fA-F]{58,}$/.test(material.extraData))
    unavailable('Malformed zone authorization.');
  return Math.min(
    sellerEnd,
    Number(BigInt(`0x${material.extraData.slice(44, 60)}`))
  );
}

export class MarketBatchPreparation {
  constructor(
    private readonly provider: OpenSeaMarketplaceProvider,
    private readonly chain: MarketChain
  ) {}

  async prepare(
    input: MarketBatchPrepareRequest,
    profileWallets: readonly string[],
    signal: AbortSignal
  ): Promise<MarketBatchPrepared> {
    const request = marketBatchPrepareSchema.parse(input);
    const wallets = new Set(
      profileWallets.map((wallet) => wallet.toLowerCase())
    );
    if (!wallets.has(request.wallet))
      unavailable('The paying wallet is no longer in this profile.');
    for (const item of request.items)
      for (const allocation of item.allocations)
        if (
          !wallets.has(allocation.recipient) &&
          !allocation.acknowledge_external_recipient
        )
          unavailable('Review every third-party recipient before continuing.');
    if ((await this.chain.rpc.getCode(request.wallet)) !== '0x')
      throw new MarketValidationError(
        'UNSUPPORTED_ACTION',
        'This paying smart wallet is not supported. Smart wallets may receive NFTs.'
      );
    const catalog = await collectingService.getCatalog();
    const byKey = new Map(
      catalog.assets.map((asset) => [asset.asset_key, asset])
    );
    const selected = request.items.map((item) => {
      const asset = byKey.get(item.asset_key);
      if (!asset)
        unavailable('A selected artwork is outside the supported catalog.');
      return { item, asset };
    });
    const prepared = await mapMarketBatch(selected, signal, ({ item, asset }) =>
      prepareLine(
        item,
        request.wallet,
        wallets,
        asset,
        this.provider,
        this.chain,
        signal
      )
    );
    const snapshot = await this.chain.snapshot();
    const intent: MarketBatchIntent = {
      kind: 'BUY_BATCH',
      chainId: 1,
      wallet: request.wallet,
      currency: MARKET_ZERO_ADDRESS,
      executionPolicy: 'ALL_OR_REVERT',
      totalWei: request.amount_wei,
      items: prepared.map((entry) => entry.line)
    };
    const materials = prepared.map((entry) => entry.material);
    const end = Math.min(
      Math.floor(Date.now() / 1000) + 90,
      ...materials.map(authorizationEnd)
    );
    if (end * 1000 <= Date.now() + 30000)
      unavailable(
        'A selected authorization expires too soon. Refresh the complete selection.'
      );
    const mirrorTerms = {
      startTime: String(snapshot.block_timestamp),
      endTime: String(end),
      salt: BigInt(`0x${randomBytes(32).toString('hex')}`).toString()
    };
    const transaction = buildMarketBatchTransaction(
      intent,
      materials,
      mirrorTerms
    );
    validateMarketBatchTransaction(intent, materials, mirrorTerms, transaction);
    assertMarketBatchActive(signal);
    const gas = await simulateMarketBatch(this.chain, transaction);
    assertMarketBatchActive(signal);
    return {
      intent,
      approvalTransactions: [],
      transaction,
      gas,
      snapshot,
      mirrorTerms,
      reviewOrders: materials.map(({ order }) => ({
        protocolAddress: order.protocolAddress,
        orderHash: order.orderHash,
        digest: order.digest,
        components: order.components
      })),
      feePolicyVersion: 'EXACT_SELECTED_SIGNED_ORDERS',
      validUntil: end * 1000
    };
  }
}
