import {
  profileActivityLogsDb,
  ProfileActivityLogsDb,
  ProfileLogSearchParams
} from '../../../profileActivityLogs/profile-activity-logs.db';
import {
  isTargetOfTypeDrop,
  ProfileActivityLog,
  ProfileActivityLogType
} from '../../../entities/IProfileActivityLog';
import { CountlessPage, PageRequest } from '../page-request';
import { profilesDb, ProfilesDb } from '../../../profiles/profiles.db';
import { RateMatter } from '../../../entities/IRating';
import { RequestContext } from '../../../request.context';
import { identitiesDb } from '../../../identities/identities.db';

export interface ProfileActivityLogsSearchRequest {
  profileId?: string;
  targetId?: string;
  logType?: ProfileActivityLogType[];
  includeProfileIdToIncoming: boolean;
  ratingMatter?: string;
  pageRequest: PageRequest;
  category?: string;
  order: 'desc' | 'asc';
  group_id: string | null;
}

export class ProfileActivityLogsApiService {
  constructor(
    private readonly profileActivityLogsDb: ProfileActivityLogsDb,
    private readonly profilesDb: ProfilesDb
  ) {}

  async getProfileActivityLogsFiltered(
    {
      profileId,
      order,
      pageRequest,
      includeProfileIdToIncoming,
      ratingMatter,
      targetId,
      logType,
      category,
      group_id
    }: ProfileActivityLogsSearchRequest,
    ctx: RequestContext
  ): Promise<CountlessPage<ApiProfileActivityLog>> {
    ctx.timer?.start(
      `${this.constructor.name}->getProfileActivityLogsFiltered`
    );
    const params: ProfileLogSearchParams = {
      order,
      pageRequest,
      includeProfileIdToIncoming,
      group_id: group_id ?? null
    };

    if (category) {
      params.category = category;
    }
    if (profileId) {
      params.profile_id = profileId;
    }
    if (targetId) {
      params.target_id = targetId;
    }
    if (logType?.length) {
      params.type = logType;
    }
    if (ratingMatter) {
      if (Object.values(RateMatter).includes(ratingMatter as RateMatter)) {
        params.rating_matter = ratingMatter as RateMatter;
      }
    }

    const foundLogs = await this.profileActivityLogsDb.searchLogs(params, ctx);
    const profileIdsInLogs = foundLogs.reduce((acc, log) => {
      acc.push(log.profile_id);
      if (log.target_id && !isTargetOfTypeDrop(log.type)) {
        acc.push(log.target_id);
      }
      const proxyId = log.proxy_id;
      if (proxyId) {
        acc.push(proxyId);
      }
      const raterProfileId = JSON.parse(log.contents).rater_profile_id;
      if (raterProfileId) {
        acc.push(raterProfileId);
      }
      return acc;
    }, [] as string[]);
    const profilesHandlesByIds = await identitiesDb.getProfileHandlesByIds(
      profileIdsInLogs,
      ctx
    );
    const convertedData = foundLogs.map((log) => {
      const logContents = JSON.parse(log.contents);
      return {
        ...log,
        contents: logContents,
        profile_handle: profilesHandlesByIds[log.profile_id],
        target_profile_handle: !isTargetOfTypeDrop(log.type)
          ? profilesHandlesByIds[log.target_id!]
          : null,
        is_target_of_type_drop: isTargetOfTypeDrop(log.type),
        proxy_handle: log.proxy_id
          ? (profilesHandlesByIds[log.proxy_id] ?? null)
          : null
      };
    });
    ctx.timer?.stop(`${this.constructor.name}->getProfileActivityLogsFiltered`);
    return {
      page: pageRequest.page,
      next: pageRequest.page_size < convertedData.length,
      data: convertedData.slice(0, pageRequest.page_size)
    };
  }
}

export interface ApiProfileActivityLog
  extends Omit<ProfileActivityLog, 'contents'> {
  readonly contents: object;
  readonly profile_handle: string;
  readonly proxy_handle: string | null;
  readonly target_profile_handle: string | null;
  readonly is_target_of_type_drop: boolean;
}

export const profileActivityLogsApiService = new ProfileActivityLogsApiService(
  profileActivityLogsDb,
  profilesDb
);
