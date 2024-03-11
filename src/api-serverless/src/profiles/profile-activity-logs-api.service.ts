import {
  profileActivityLogsDb,
  ProfileActivityLogsDb,
  ProfileLogSearchParams
} from '../../../profileActivityLogs/profile-activity-logs.db';
import {
  ProfileActivityLog,
  ProfileActivityLogType
} from '../../../entities/IProfileActivityLog';
import { Chunk, PageRequest } from '../page-request';
import { profilesDb, ProfilesDb } from '../../../profiles/profiles.db';
import {
  getMattersWhereTargetIsProfile,
  RateMatter
} from '../../../entities/IRating';

export interface ProfileActivityLogsSearchRequest {
  profileId?: string;
  targetId?: string;
  logType?: ProfileActivityLogType[];
  includeProfileIdToIncoming: boolean;
  ratingMatter?: string;
  pageRequest: PageRequest;
  order: 'desc' | 'asc';
  curation_criteria_id: string | null;
}

export class ProfileActivityLogsApiService {
  constructor(
    private readonly profileActivityLogsDb: ProfileActivityLogsDb,
    private readonly profilesDb: ProfilesDb
  ) {}

  async getProfileActivityLogsFiltered({
    profileId,
    order,
    pageRequest,
    includeProfileIdToIncoming,
    ratingMatter,
    targetId,
    logType,
    curation_criteria_id
  }: ProfileActivityLogsSearchRequest): Promise<Chunk<ApiProfileActivityLog>> {
    const params: ProfileLogSearchParams = {
      order,
      pageRequest,
      includeProfileIdToIncoming,
      curation_criteria_id: curation_criteria_id ?? null
    };

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
    const foundLogs = await this.profileActivityLogsDb.searchLogs({
      ...params,
      pageRequest: {
        ...params.pageRequest,
        page_size: params.pageRequest.page_size + 1
      }
    });
    const profileIdsInLogs = foundLogs.reduce((acc, log) => {
      acc.push(log.profile_id);
      if (log.target_id) {
        acc.push(log.target_id);
      }
      return acc;
    }, [] as string[]);
    const profilesHandlesByIds = await this.profilesDb.getProfileHandlesByIds(
      profileIdsInLogs
    );
    const convertedData = foundLogs.map((log) => {
      const logContents = JSON.parse(log.contents);
      return {
        ...log,
        contents: logContents,
        profile_handle: profilesHandlesByIds[log.profile_id]!,
        target_profile_handle:
          log.type === ProfileActivityLogType.RATING_EDIT &&
          getMattersWhereTargetIsProfile().includes(logContents.rating_matter)
            ? profilesHandlesByIds[log.target_id!]
            : null
      };
    });
    return {
      page: pageRequest.page,
      next: foundLogs.length > pageRequest.page_size,
      data: convertedData.slice(0, pageRequest.page_size)
    };
  }
}

export interface ApiProfileActivityLog
  extends Omit<ProfileActivityLog, 'contents'> {
  readonly contents: object;
  readonly profile_handle: string;
  readonly target_profile_handle: string | null;
}

export const profileActivityLogsApiService = new ProfileActivityLogsApiService(
  profileActivityLogsDb,
  profilesDb
);
