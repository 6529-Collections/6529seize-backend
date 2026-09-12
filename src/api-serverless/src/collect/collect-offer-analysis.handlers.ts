import * as Operations from '@/api/generated/routes/operations';
import { executeMarketRequest } from '@/api/marketplace/marketplace.http';
import { offerAnalysisSchema } from '@/collecting/collecting-offer-analysis.types';
import { analyzeCollectOffers } from '@/api/collect/collect-offer-analysis.service';
import { BadRequestException } from '@/exceptions';

export function handleAnalyzeCollectOffers(
  req: Operations.AnalyzeCollectOffersRequest
): Promise<Operations.AnalyzeCollectOffersResponse> {
  return executeMarketRequest(req, (auth) => {
    const input = offerAnalysisSchema.safeParse(req.body);
    if (!input.success)
      throw new BadRequestException('Invalid collecting or trade request.');
    return analyzeCollectOffers(auth, input.data);
  });
}
