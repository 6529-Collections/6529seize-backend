import { asyncRouter } from '../async.router';
import { ApiResponse } from '../api-response';
import {
  ApiProfileActivityLog,
  profileActivityLogsApiService,
  ProfileActivityLogsSearchRequest
} from './profile-activity-logs-api.service';
import { Request, Response } from 'express';
import { ProfileActivityLogType } from '../../../entities/IProfileActivityLog';
import { CountlessPage } from '../page-request';
import { getAuthenticationContext, maybeAuthenticatedUser } from '../auth/auth';
import { Timer } from '../../../time';
import { identityFetcher } from '../identities/identity.fetcher';

const router = asyncRouter();

async function getBaseSearchRequest(
  req: Request<
    any,
    any,
    any,
    {
      order?: string;
      profile?: string;
      target?: string;
      log_type?: ProfileActivityLogType;
      group_id?: string;
      page?: string;
      page_size?: string;
      rating_matter?: string;
      include_incoming?: string;
      category?: string;
    },
    any
  >
): Promise<ProfileActivityLogsSearchRequest> {
  const timer = Timer.getFromRequest(req);
  const queryParams = req.query;
  const order = queryParams.order?.toLowerCase() === 'asc' ? 'asc' : 'desc';
  const profile = queryParams.profile;
  const category = queryParams.category;
  const includeProfileIdToIncoming =
    queryParams.include_incoming?.toLowerCase() === 'true';
  const ratingMatter = queryParams.rating_matter;
  let profileId = undefined;
  if (profile) {
    profileId = await identityFetcher
      .getProfileIdByIdentityKey({ identityKey: profile }, { timer })
      .then((result) => result ?? '-');
  }
  const targetId = queryParams.target
    ? await identityFetcher
        .getProfileIdByIdentityKey(
          { identityKey: queryParams.target },
          { timer }
        )
        .then((result) => result ?? queryParams.target)
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
    group_id: req.query.group_id ?? null,
    profileId,
    order,
    includeProfileIdToIncoming,
    ratingMatter,
    category,
    pageRequest: {
      page,
      page_size: size
    },
    targetId,
    logType: logType
  };
}

router.get(
  `/`,
  maybeAuthenticatedUser(),
  async function (
    req: Request<
      any,
      any,
      any,
      {
        group_id?: string;
        order?: string;
        profile?: string;
        target?: string;
        log_type?: ProfileActivityLogType;
        page?: string;
        page_size?: string;
        rating_matter?: string;
        include_incoming?: string;
        category?: string;
      },
      any
    >,
    res: Response<ApiResponse<CountlessPage<ApiProfileActivityLog>>>
  ) {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    const profileActivityLogsSearchRequest = await getBaseSearchRequest(req);
    const results =
      await profileActivityLogsApiService.getProfileActivityLogsFiltered(
        profileActivityLogsSearchRequest,
        { timer, authenticationContext }
      );
    res.status(200).send(results);
  }
);

export default router;
