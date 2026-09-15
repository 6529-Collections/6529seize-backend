import { z } from 'zod';
import {
  PreflightMarketBatchRequest,
  PreflightMarketBatchResponse
} from '@/api/generated/routes/operations';
import { executeMarketRequest } from '@/api/marketplace/marketplace.http';
import { preflightMarketBatch } from '@/api/marketplace/marketplace-batch-preflight';

const inputSchema = z
  .object({
    expected_revision: z.string().regex(/^[0-9a-f]{64}$/),
    transaction_digest: z.string().regex(/^[0-9a-f]{64}$/)
  })
  .strict();

export function handlePreflightMarketBatch(
  req: PreflightMarketBatchRequest
): Promise<PreflightMarketBatchResponse> {
  return executeMarketRequest(req, (auth) =>
    preflightMarketBatch(
      z.string().uuid().parse(req.params.id),
      auth,
      inputSchema.parse(req.body)
    )
  );
}
