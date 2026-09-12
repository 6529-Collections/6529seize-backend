import * as Operations from '@/api/generated/routes/operations';
import { executeMarketRequest } from '@/api/marketplace/marketplace.http';
import { offerAnalysisSchema } from '@/collecting/collecting-offer-analysis.types';
import { analyzeCollectOffers } from '@/api/collect/collect-offer-analysis.service';

export function handleAnalyzeCollectOffers(
  req: Operations.AnalyzeCollectOffersRequest
): Promise<Operations.AnalyzeCollectOffersResponse> {
  return executeMarketRequest(req, (auth) =>
    analyzeCollectOffers(auth, offerAnalysisSchema.parse(req.body))
  );
}
