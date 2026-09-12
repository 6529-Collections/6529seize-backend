import { executeMarketRequest as execute } from './marketplace.http';
import { z } from 'zod';
import * as Operations from '@/api/generated/routes/operations';
import * as BatchCapabilities from '@/api/generated/models/ApiMarketBatchCapabilities';
import { marketCatalogAsset } from '@/marketplace/market-preparation';
import { marketHashSchema } from '@/marketplace/seaport.schema';
import {
  continueMarketOperation,
  listMarketOperations,
  marketplaceProvider,
  prepareMarketOperation,
  publishMarketOperation,
  readMarketOperation,
  submitMarketOperation,
  beginMarketTransactionAttempt,
  rejectMarketTransactionAttempt
} from './marketplace.service';
import { MARKET_BATCH_LIMITS } from '@/marketplace/market-batch.schema';
import { marketOperationPrepareSchema } from '@/marketplace/market-operation.types';
import { discoveredOrderDto } from '@/api/marketplace/marketplace.dto';
import {
  marketOrderResolutionQuerySchema,
  marketOrderResolutionSchema,
  resolveMarketOrder
} from './marketplace-order-resolution';

const idSchema = z.string().uuid();

export function handleGetMarketBatchCapabilities(
  req: Operations.GetMarketBatchCapabilitiesRequest
): Promise<Operations.GetMarketBatchCapabilitiesResponse> {
  return execute(req, async () => ({
    available:
      !!process.env.OPENSEA_API_KEY &&
      (process.env.MARKETPLACE_TRADING_ENABLED ?? 'true') === 'true',
    execution_policy:
      BatchCapabilities.ApiMarketBatchCapabilitiesExecutionPolicyEnum
        .AllOrRevert,
    currency:
      BatchCapabilities.ApiMarketBatchCapabilitiesCurrencyEnum
        ._0x0000000000000000000000000000000000000000,
    payer_type: BatchCapabilities.ApiMarketBatchCapabilitiesPayerTypeEnum.Eoa,
    ...MARKET_BATCH_LIMITS,
    restricted_erc1155_max_order_quantity:
      BatchCapabilities
        .ApiMarketBatchCapabilitiesRestrictedErc1155MaxOrderQuantityEnum._1,
    requires_complete_simulation: true
  }));
}

export function handleBeginMarketTransactionAttempt(
  req: Operations.BeginMarketTransactionAttemptRequest
): Promise<Operations.BeginMarketTransactionAttemptResponse> {
  return execute(req, (auth) =>
    beginMarketTransactionAttempt(
      idSchema.parse(req.params.id),
      auth,
      z
        .object({
          expected_revision: z.string().regex(/^[0-9a-f]{64}$/),
          attempt_id: idSchema,
          purpose: z.enum(['APPROVAL', 'TRANSACTION']),
          transaction_digest: z.string().regex(/^[0-9a-f]{64}$/)
        })
        .strict()
        .parse(req.body)
    )
  );
}

export function handleRejectMarketTransactionAttempt(
  req: Operations.RejectMarketTransactionAttemptRequest
): Promise<Operations.RejectMarketTransactionAttemptResponse> {
  return execute(req, (auth) => {
    const input = z
      .object({
        attempt_id: idSchema,
        reason: z.enum(['USER_REJECTED', 'WALLET_NOT_REQUESTED']),
        expected_revision: z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .optional()
      })
      .strict()
      .parse(req.body);
    return rejectMarketTransactionAttempt(
      idSchema.parse(req.params.id),
      auth,
      input.attempt_id,
      input.reason,
      input.expected_revision
    );
  });
}

export async function handleGetMarketOrders(
  req: Operations.GetMarketOrdersRequest
): Promise<Operations.GetMarketOrdersResponse> {
  return execute(req, async () => {
    const query = z
      .object({
        asset_key: z.string().min(1).max(150),
        side: z.enum(['LISTING', 'OFFER'])
      })
      .strict()
      .parse(req.query);
    const asset = await marketCatalogAsset(query.asset_key);
    const orders = await marketplaceProvider().discoverOrders(
      {
        contract: asset.contract,
        tokenId: asset.token_id,
        standard: asset.family === 'memes' ? 'ERC1155' : 'ERC721'
      },
      query.side
    );
    return {
      source: 'OpenSea',
      observed_at: Date.now(),
      complete: false,
      orders: orders.map((order) => discoveredOrderDto(order, asset.asset_key))
    };
  });
}

export function handleGetMarketOrder(
  req: Operations.GetMarketOrderRequest
): Promise<Operations.GetMarketOrderResponse> {
  return execute(req, () =>
    resolveMarketOrder(
      marketOrderResolutionSchema.parse({
        ...marketOrderResolutionQuerySchema.parse(req.query),
        order_hash: req.params.order_hash
      })
    )
  );
}

export function handlePrepareMarketOperation(
  req: Operations.PrepareMarketOperationRequest
): Promise<Operations.PrepareMarketOperationResponse> {
  return execute(req, (auth) =>
    prepareMarketOperation(
      auth,
      marketOperationPrepareSchema.parse(req.body),
      idSchema.parse(req.get('Idempotency-Key'))
    )
  );
}
export function handleGetMarketOperation(
  req: Operations.GetMarketOperationRequest
): Promise<Operations.GetMarketOperationResponse> {
  return execute(req, (auth) =>
    readMarketOperation(idSchema.parse(req.params.id), auth)
  );
}
export function handleGetMyMarketOperations(
  req: Operations.GetMyMarketOperationsRequest
): Promise<Operations.GetMyMarketOperationsResponse> {
  return execute(req, (auth) =>
    listMarketOperations(
      auth,
      z
        .object({
          limit: z.coerce.number().int().min(1).max(50).default(20),
          cursor: z.string().min(1).max(200).optional(),
          include_batches: z
            .union([
              z.boolean(),
              z.enum(['true', 'false']).transform((value) => value === 'true')
            ])
            .optional()
        })
        .strict()
        .parse(req.query)
    )
  );
}
export function handleContinueMarketOperation(
  req: Operations.ContinueMarketOperationRequest
): Promise<Operations.ContinueMarketOperationResponse> {
  return execute(req, (auth) =>
    continueMarketOperation(idSchema.parse(req.params.id), auth)
  );
}
export function handlePublishMarketOperation(
  req: Operations.PublishMarketOperationRequest
): Promise<Operations.PublishMarketOperationResponse> {
  return execute(req, (auth) => {
    const body = z
      .object({ signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/) })
      .strict()
      .parse(req.body);
    return publishMarketOperation(
      idSchema.parse(req.params.id),
      auth,
      body.signature
    );
  });
}
export function handleSubmitMarketOperation(
  req: Operations.SubmitMarketOperationRequest
): Promise<Operations.SubmitMarketOperationResponse> {
  return execute(req, (auth) => {
    const body = z
      .object({ transaction_hash: marketHashSchema })
      .strict()
      .parse(req.body);
    return submitMarketOperation(
      idSchema.parse(req.params.id),
      auth,
      body.transaction_hash
    );
  });
}
