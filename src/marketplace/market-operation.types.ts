import { z } from 'zod';
import {
  MarketPrepared,
  MarketPrepareRequest,
  marketPrepareSchema
} from '@/marketplace/market-preparation';
import {
  MarketBatchPrepareRequest,
  marketBatchPrepareSchema
} from '@/marketplace/market-batch.schema';
import { MarketBatchPrepared } from '@/marketplace/market-batch.types';

export type MarketOperationPrepareRequest =
  | MarketPrepareRequest
  | MarketBatchPrepareRequest;
export type MarketOperationPrepared = MarketPrepared | MarketBatchPrepared;
export const marketOperationPrepareSchema = z.union([
  marketPrepareSchema,
  marketBatchPrepareSchema
]);

export function isMarketBatchPrepared(
  prepared: MarketOperationPrepared
): prepared is MarketBatchPrepared {
  return prepared.intent.kind === 'BUY_BATCH';
}
