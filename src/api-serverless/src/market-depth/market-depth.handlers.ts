import { ApiMarketDepth } from '@/api/generated/models/ApiMarketDepth';
import { ApiNftActivityPage } from '@/api/generated/models/ApiNftActivityPage';
import {
  GetNftMarketActivityRequest,
  GetNftMarketDepthRequest
} from '@/api/generated/routes/operations';
import { marketDepthApiDb } from './market-depth-api.db';
import { buildMarketDepthResponse } from './market-depth.service';
import {
  validateActivityQuery,
  validateDepthPath,
  validateDepthQuery
} from './market-depth.validation';
import { nftMarketActivityService } from './nft-market-activity.service';

export async function handleGetNftMarketDepth(
  req: GetNftMarketDepthRequest
): Promise<ApiMarketDepth> {
  const path = validateDepthPath(req.params);
  const query = validateDepthQuery(req.query);
  const token = await marketDepthApiDb.getToken(path.contract, path.token_id);
  const books = await marketDepthApiDb.getBooks(token);
  return buildMarketDepthResponse(
    path.contract,
    path.token_id,
    books,
    query.page_size,
    query.cursor
  );
}

export async function handleGetNftMarketActivity(
  req: GetNftMarketActivityRequest
): Promise<ApiNftActivityPage> {
  return nftMarketActivityService.getActivity(validateActivityQuery(req.query));
}
