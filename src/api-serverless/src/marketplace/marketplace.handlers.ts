import { executeMarketRequest as execute } from './marketplace.http';
import { z } from 'zod';
import * as Operations from '@/api/generated/routes/operations';
import { ApiMarketOrderSideEnum } from '@/api/generated/models/ApiMarketOrder';
import {
  marketCatalogAsset,
  marketPrepareSchema
} from '@/marketplace/market-preparation';
import { marketHashSchema } from '@/marketplace/seaport.schema';
import {
  continueMarketOperation,
  listMarketOperations,
  marketplaceProvider,
  prepareMarketOperation,
  publishMarketOperation,
  readMarketOperation,
  submitMarketOperation
} from './marketplace.service';

const idSchema = z.string().uuid();

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
      orders: orders.map((order) => ({
        identity: {
          protocol_address: order.identity.protocolAddress,
          order_hash: order.identity.orderHash
        },
        asset_key: asset.asset_key,
        maker: order.maker,
        recipient: order.recipient,
        side: order.side as ApiMarketOrderSideEnum,
        quantity: order.quantity,
        currency: order.currency,
        total_wei: order.totalWei,
        net_wei: order.netWei,
        fees: order.fees.map((fee) => ({
          recipient: fee.recipient,
          amount_wei: fee.amountWei
        })),
        start_time: order.startTime,
        end_time: order.endTime
      }))
    };
  });
}

export function handlePrepareMarketOperation(
  req: Operations.PrepareMarketOperationRequest
): Promise<Operations.PrepareMarketOperationResponse> {
  return execute(req, (auth) =>
    prepareMarketOperation(
      auth,
      marketPrepareSchema.parse(req.body),
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
          cursor: z.string().min(1).max(200).optional()
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
