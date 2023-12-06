import { asyncRouter } from '../async.router';
import { ApiResponse } from '../api-response';
import { Page } from '../page-request';
import {
  ApiProfileActivtyLog,
  profileActivityLogsApiService
} from './profile-activity-logs-api.service';
import { Request, Response } from 'express';
import {
  ProfileActivityLogTargetType,
  ProfileActivityLogType
} from '../../../entities/IProfileActivityLog';
import { profilesService } from '../../../profiles/profiles.service';

const router = asyncRouter();

router.get(
  `/`,
  async function (
    req: Request<
      any,
      any,
      any,
      {
        order?: string;
        profile?: string;
        target?: string;
        target_type?: string;
        log_type?: ProfileActivityLogType;
        page?: string;
        page_size?: string;
      },
      any
    >,
    res: Response<ApiResponse<Page<ApiProfileActivtyLog>>>
  ) {
    const queryParams = req.query;
    const order = queryParams.order?.toLowerCase() === 'asc' ? 'asc' : 'desc';
    const profile = queryParams.profile;
    let profileId = undefined;
    if (profile) {
      profileId = await profilesService
        .getProfileAndConsolidationsByHandleOrEnsOrWalletAddress(profile)
        .then((result) => result?.profile?.external_id ?? '-');
    }
    let targetId = queryParams.target;
    if (
      queryParams.target_type === ProfileActivityLogTargetType.PROFILE_ID &&
      targetId
    ) {
      targetId = await profilesService
        .getProfileAndConsolidationsByHandleOrEnsOrWalletAddress(targetId)
        .then((result) => result?.profile?.external_id ?? '-');
    }
    const targetType = Object.values(ProfileActivityLogTargetType).find(
      (t) => t?.toUpperCase() === queryParams.target_type
    );
    const logType = Object.values(ProfileActivityLogType).find(
      (t) => t?.toUpperCase() === queryParams.log_type
    );
    const pageProposal = parseInt(queryParams.page ?? '1');

    const page = !isNaN(pageProposal) && pageProposal > 0 ? pageProposal : 1;
    const sizeProposal = parseInt(queryParams.page_size || '2000');
    const size = !isNaN(sizeProposal) && sizeProposal > 0 ? sizeProposal : 50;
    const results = await profileActivityLogsApiService.getProfileActivityLogs({
      profileId,
      order,
      pageRequest: {
        page,
        page_size: size
      },
      targetId,
      targetType,
      logType
    });
    res.status(200).send(results);
  }
);

export default router;
