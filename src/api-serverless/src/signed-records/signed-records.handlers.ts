import { ApiSignedRecordsAnchor } from '@/api/generated/models/ApiSignedRecordsAnchor';
import { GetSignedRecordsAnchorRequest } from '@/api/generated/routes/operations';
import {
  RecordAnchorService,
  recordAnchorService
} from '@/signed-records/record-anchor';

/** GET /signed-records/anchor: the height to sign as a record's anchor. */
export async function handleGetSignedRecordsAnchor(
  _req: GetSignedRecordsAnchorRequest,
  service: RecordAnchorService = recordAnchorService
): Promise<ApiSignedRecordsAnchor> {
  const anchor = await service.getAnchor();
  return {
    anchor: anchor.anchor,
    head_height: anchor.headHeight,
    finalized_time: anchor.finalizedTime,
    max_anchor_lag: anchor.maxAnchorLag
  };
}
