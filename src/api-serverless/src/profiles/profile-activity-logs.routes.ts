import { asyncRouter } from '../async.router';
import { ApiResponse } from '../api-response';
import { Chunk } from '../page-request';
import {
  ApiProfileActivityLog,
  profileActivityLogsApiService,
  ProfileActivityLogsSearchRequest
} from './profile-activity-logs-api.service';
import { Request, Response } from 'express';
import { ProfileActivityLogType } from '../../../entities/IProfileActivityLog';
import { profilesService } from '../../../profiles/profiles.service';
import { CommunityMembersCurationCriteria } from '../community-members/community-search-criteria.types';

const router = asyncRouter();

async function getBaseSearchRequest(
  req: Request<
    any,
    any,
    CommunityMembersCurationCriteria,
    {
      order?: string;
      profile?: string;
      target?: string;
      log_type?: ProfileActivityLogType;
      curation_criteria_id?: string;
      page?: string;
      page_size?: string;
      rating_matter?: string;
      include_incoming?: string;
    },
    any
  >
): Promise<ProfileActivityLogsSearchRequest> {
  const queryParams = req.query;
  const order = queryParams.order?.toLowerCase() === 'asc' ? 'asc' : 'desc';
  const profile = queryParams.profile;
  const includeProfileIdToIncoming =
    queryParams.include_incoming?.toLowerCase() === 'true';
  const ratingMatter = queryParams.rating_matter;
  let profileId = undefined;
  if (profile) {
    profileId = await profilesService
      .getProfileAndConsolidationsByHandleOrEnsOrWalletAddress(profile)
      .then((result) => result?.profile?.external_id ?? '-');
  }
  const targetId = queryParams.target
    ? await profilesService
        .getProfileAndConsolidationsByHandleOrEnsOrWalletAddress(
          queryParams.target
        )
        .then((result) => result?.profile?.external_id ?? queryParams.target)
    : queryParams.target;
  const logType = queryParams.log_type
    ?.split(',')
    .filter((logType) =>
      Object.values(ProfileActivityLogType).find(
        (t) => t?.toUpperCase() === logType.toUpperCase()
      )
    )
    ?.map((logType) => logType.toUpperCase()) as
    | ProfileActivityLogType[]
    | undefined;
  const pageProposal = parseInt(queryParams.page ?? '1');

  const page = !isNaN(pageProposal) && pageProposal > 0 ? pageProposal : 1;
  const sizeProposal = parseInt(queryParams.page_size || '2000');
  const size = !isNaN(sizeProposal) && sizeProposal > 0 ? sizeProposal : 50;
  return {
    curation_criteria_id: req.query.curation_criteria_id ?? null,
    profileId,
    order,
    includeProfileIdToIncoming,
    ratingMatter,
    pageRequest: {
      page,
      page_size: size
    },
    targetId,
    logType: logType
  };
}

router.post(
  `/`,
  async function (
    req: Request<
      any,
      any,
      CommunityMembersCurationCriteria,
      {
        curation_criteria_id?: string;
        order?: string;
        profile?: string;
        target?: string;
        log_type?: ProfileActivityLogType;
        page?: string;
        page_size?: string;
        rating_matter?: string;
        include_incoming?: string;
      },
      any
    >,
    res: Response<ApiResponse<Chunk<ApiProfileActivityLog>>>
  ) {
    const profileActivityLogsSearchRequest = await getBaseSearchRequest(req);
    const results =
      await profileActivityLogsApiService.getProfileActivityLogsFiltered(
        profileActivityLogsSearchRequest
      );
    res.status(200).send(results);
  }
);

export default router;
