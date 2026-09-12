import { z } from 'zod';
import { TypedDataEncoder } from 'ethers';
import { collectingService } from '@/collecting/collecting.service';
import { CollectingAsset } from '@/collecting/collecting.types';
import { collectingAssetKey } from '@/collecting/collecting-analysis';
import {
  OpenSeaMarketplaceProvider,
  marketFeesForTotal,
  describeMarketOrder
} from '@/marketplace/provider.opensea';
import { MarketChain } from '@/marketplace/market-chain';
import {
  MarketTradeIntent,
  MarketTransaction,
  PreparedOrder,
  MarketValidationError,
  ValidatedMarketOrder,
  MarketProviderOrder,
  MarketGasEstimate
} from '@/marketplace/provider.types';
import {
  MARKET_SEAPORT,
  MARKET_ZERO_ADDRESS,
  MARKET_WETH,
  MARKET_ZERO_HASH
} from '@/marketplace/seaport.registry';
import {
  marketAddressSchema,
  marketHashSchema,
  marketUintSchema,
  SEAPORT_ORDER_TYPES,
  marketOrderComponentsSchema,
  parseMarketValue
} from '@/marketplace/seaport.schema';
import {
  validateMarketOrder,
  sameMarketAddress
} from '@/marketplace/quote-validation';
import { prepareMarketCancel } from '@/marketplace/seaport.builder';

export const marketPrepareSchema = z
  .object({
    profile_id: z.string().min(1).max(100),
    wallet: marketAddressSchema,
    recipient: marketAddressSchema,
    asset_key: z.string().min(1).max(150),
    kind: z.enum(['BUY', 'LIST', 'OFFER', 'ACCEPT', 'CANCEL']),
    quantity: marketUintSchema,
    currency: marketAddressSchema,
    amount_wei: marketUintSchema,
    expires_at: z.number().int().positive().optional(),
    order: z
      .object({
        protocol_address: marketAddressSchema,
        order_hash: marketHashSchema
      })
      .strict()
      .optional(),
    acknowledge_external_recipient: z.boolean()
  })
  .strict()
  .superRefine((request, context) => {
    const createsOrder = request.kind === 'LIST' || request.kind === 'OFFER';
    if (createsOrder !== (request.expires_at !== undefined))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expires_at'],
        message:
          'Order expiry in Unix seconds is required only for LIST and OFFER.'
      });
    if (!createsOrder && !request.order)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['order'],
        message: 'Select an exact order to buy, accept, or cancel.'
      });
  });
export type MarketPrepareRequest = z.infer<typeof marketPrepareSchema>;
export type KnownMarketOrder = Pick<
  MarketProviderOrder,
  'identity' | 'components'
>;
export interface MarketPrepared {
  intent: MarketTradeIntent;
  recipientInProfile: boolean;
  approvalTransactions: MarketTransaction[];
  transaction?: MarketTransaction;
  signedOrder?: PreparedOrder;
  snapshot: {
    block_number: number;
    block_hash: string;
    block_timestamp: number;
  };
  gas?: MarketGasEstimate;
  feePolicyVersion: string;
  nftRecipient?: string;
  reviewOrder?: Pick<
    ValidatedMarketOrder,
    'protocolAddress' | 'orderHash' | 'digest' | 'components'
  >;
}

export async function marketCatalogAsset(
  key: string
): Promise<CollectingAsset> {
  const catalog = await collectingService.getCatalog();
  const asset = catalog.assets.find((item) => item.asset_key === key);
  if (!asset)
    throw new MarketValidationError(
      'INVALID_INTENT',
      'The artwork is not in the supported collection catalog.'
    );
  return asset;
}

export class MarketPreparation {
  constructor(
    private readonly provider: OpenSeaMarketplaceProvider,
    private readonly chain: MarketChain
  ) {}

  async prepare(
    request: MarketPrepareRequest,
    recipientInProfile: boolean,
    knownOrder?: KnownMarketOrder
  ): Promise<MarketPrepared> {
    // Execution through contract wallets needs a verified wrapper/receipt path.
    // An NFT recipient may still be any explicitly reviewed account, including a Safe.
    if ((await this.chain.rpc.getCode(request.wallet)) !== '0x')
      throw new MarketValidationError(
        'UNSUPPORTED_ACTION',
        'Trading from this smart wallet is not available yet. A smart wallet can still receive an NFT.'
      );
    const snapshot = await this.chain.snapshot();
    if (request.kind === 'CANCEL')
      return this.cancel(request, snapshot, recipientInProfile, knownOrder);
    const asset = await marketCatalogAsset(request.asset_key);
    if (BigInt(request.quantity) < BigInt(1))
      throw new MarketValidationError(
        'INVALID_INTENT',
        'Choose a positive quantity.'
      );
    if (!recipientInProfile && !request.acknowledge_external_recipient)
      throw new MarketValidationError(
        'INVALID_INTENT',
        'Review the third-party recipient before continuing.'
      );
    const intent: MarketTradeIntent = {
      kind: request.kind,
      chainId: 1,
      wallet: request.wallet.toLowerCase(),
      recipient: request.recipient.toLowerCase(),
      asset: {
        contract: asset.contract,
        tokenId: asset.token_id,
        standard: asset.family === 'memes' ? 'ERC1155' : 'ERC721'
      },
      quantity: request.quantity,
      currency: request.currency.toLowerCase(),
      maxTotalWei: request.amount_wei,
      minNetWei: request.amount_wei,
      fees: [],
      includeOptionalCreatorFees: false,
      ...(request.order
        ? {
            order: {
              protocolAddress: request.order.protocol_address,
              orderHash: request.order.order_hash
            }
          }
        : {})
    };
    if (
      intent.currency !== MARKET_ZERO_ADDRESS &&
      intent.currency !== MARKET_WETH
    )
      throw new MarketValidationError(
        'INVALID_INTENT',
        'Only ETH and WETH are supported.'
      );
    if (request.kind === 'LIST' || request.kind === 'OFFER') {
      if (request.kind === 'OFFER') {
        if (intent.currency !== MARKET_WETH)
          throw new MarketValidationError(
            'INVALID_INTENT',
            'Offers require WETH.'
          );
        const balance = await this.chain.currencyBalance(
          MARKET_WETH,
          intent.wallet
        );
        if (BigInt(balance) < BigInt(intent.maxTotalWei))
          throw new MarketValidationError(
            'AMOUNT_MISMATCH',
            'This wallet needs enough WETH for the full offer amount before preparing an offer.'
          );
      }
      const policy = await this.provider.getFeePolicy(intent.asset);
      intent.fees = marketFeesForTotal(
        policy,
        request.amount_wei,
        request.kind === 'LIST'
      );
      const fees = intent.fees.reduce(
        (sum, fee) => sum + BigInt(fee.amountWei),
        BigInt(0)
      );
      if (fees > BigInt(request.amount_wei))
        throw new MarketValidationError(
          'AMOUNT_MISMATCH',
          'Invalid fee total.'
        );
      intent.minNetWei = (BigInt(request.amount_wei) - fees).toString();
      intent.includeOptionalCreatorFees = request.kind === 'LIST';
      const expiry = request.expires_at;
      if (
        !expiry ||
        expiry < snapshot.block_timestamp + 300 ||
        expiry > snapshot.block_timestamp + 86400 * 30
      )
        throw new MarketValidationError(
          'INVALID_INTENT',
          'Choose an order expiry between five minutes and thirty days.'
        );
      intent.startTime = String(snapshot.block_timestamp);
      intent.endTime = String(expiry);
      const signedOrder = await this.provider.prepareOrder(intent);
      if (
        signedOrder.order.components.counter !==
        (await this.chain.counter(intent.wallet))
      )
        throw new MarketValidationError(
          'ORDER_MISMATCH',
          'The maker counter changed.'
        );
      const approvalTransactions = await this.chain.approvals(
        intent,
        signedOrder.order.components.conduitKey
      );
      return {
        intent,
        recipientInProfile,
        signedOrder,
        approvalTransactions,
        snapshot,
        feePolicyVersion: policy.version
      };
    }
    if (!intent.order)
      throw new MarketValidationError(
        'INVALID_INTENT',
        'Select an exact order.'
      );
    const order = await this.provider.getOrder(intent.order);
    const economics = describeMarketOrder(
      order,
      intent.asset,
      request.kind === 'BUY' ? 'LISTING' : 'OFFER',
      request.quantity
    );
    if (
      economics.currency.toLowerCase() !== intent.currency ||
      economics.totalWei !== request.amount_wei
    )
      throw new MarketValidationError(
        'AMOUNT_MISMATCH',
        'The selected order price changed. Review the exact total again.'
      );
    intent.fees = economics.fees;
    intent.minNetWei = economics.netWei;
    if (request.kind === 'ACCEPT' && intent.recipient !== intent.wallet)
      throw new MarketValidationError(
        'INVALID_INTENT',
        'Sale proceeds must return to the signing wallet.'
      );
    const status = await this.chain.orderStatus(intent.order.orderHash);
    if (
      status.cancelled ||
      (status.size > BigInt(0) && status.filled >= status.size)
    )
      throw new MarketValidationError(
        'ORDER_MISMATCH',
        'This order is no longer available.'
      );
    const transaction = await this.provider.prepareFulfillment(
      intent,
      await this.chain.counter(order.components.offerer),
      order
    );
    // The fulfiller's outgoing asset operator is encoded by our builder. Native ETH needs no approval.
    const approvalTransactions = await this.chain.approvals(intent);
    const gas =
      approvalTransactions.length === 0
        ? await this.chain.simulate(transaction)
        : undefined;
    const reviewOrder = validateMarketOrder(
      intent,
      order.components,
      order.identity.protocolAddress
    );
    return {
      intent,
      recipientInProfile,
      transaction,
      approvalTransactions,
      snapshot,
      reviewOrder,
      feePolicyVersion: MARKET_ZERO_HASH,
      nftRecipient:
        request.kind === 'BUY' ? intent.recipient : economics.recipient,
      ...(gas ? { gas } : {})
    };
  }

  private async cancel(
    request: MarketPrepareRequest,
    snapshot: MarketPrepared['snapshot'],
    recipientInProfile: boolean,
    knownOrder?: KnownMarketOrder
  ): Promise<MarketPrepared> {
    if (!request.order)
      throw new MarketValidationError(
        'INVALID_INTENT',
        'Select an order to cancel.'
      );
    const identity = {
      protocolAddress: request.order.protocol_address,
      orderHash: request.order.order_hash
    };
    const order = knownOrder ?? (await this.provider.getOrder(identity));
    if (
      !sameMarketAddress(
        order.identity.protocolAddress,
        identity.protocolAddress
      ) ||
      !sameMarketAddress(order.identity.orderHash, identity.orderHash)
    )
      throw new MarketValidationError(
        'ORDER_MISMATCH',
        'The saved cancellation target differs from the requested order.'
      );
    const components = parseMarketValue(
      marketOrderComponentsSchema,
      order.components
    );
    const nft = [...components.offer, ...components.consideration].find(
      (item) => item.itemType === 2 || item.itemType === 3
    );
    if (
      !nft ||
      collectingAssetKey(nft.token, nft.identifierOrCriteria) !==
        request.asset_key.toLowerCase()
    )
      throw new MarketValidationError(
        'ORDER_MISMATCH',
        'The cancellation artwork differs from the reviewed order.'
      );
    const intent: MarketTradeIntent = {
      kind: 'LIST',
      chainId: 1,
      wallet: request.wallet.toLowerCase(),
      recipient: request.wallet.toLowerCase(),
      asset: {
        contract: nft.token.toLowerCase(),
        tokenId: nft.identifierOrCriteria,
        standard: nft.itemType === 2 ? 'ERC721' : 'ERC1155'
      },
      quantity: nft.startAmount,
      currency: request.currency.toLowerCase(),
      maxTotalWei: '0',
      minNetWei: '0',
      fees: [],
      includeOptionalCreatorFees: false,
      order: identity
    };
    const transaction = prepareMarketCancel(
      request.wallet,
      order.identity,
      components
    );
    const reviewOrder = {
      ...order.identity,
      components,
      digest: TypedDataEncoder.hash(
        {
          name: 'Seaport',
          version: '1.6',
          chainId: 1,
          verifyingContract: MARKET_SEAPORT
        },
        SEAPORT_ORDER_TYPES,
        components
      )
    };
    return {
      intent,
      recipientInProfile,
      transaction,
      approvalTransactions: [],
      snapshot,
      reviewOrder,
      feePolicyVersion: MARKET_ZERO_HASH,
      gas: await this.chain.simulate(transaction)
    };
  }
}
