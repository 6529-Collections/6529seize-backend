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
import { Page, PageRequest } from '../page-request';
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
  category?: string;
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
    category,
    curation_criteria_id
  }: ProfileActivityLogsSearchRequest): Promise<Page<ApiProfileActivityLog>> {
    const params: ProfileLogSearchParams = {
      order,
      pageRequest,
      includeProfileIdToIncoming,
      curation_criteria_id: curation_criteria_id ?? null
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
    const [foundLogs, logCount] = await Promise.all([
      this.profileActivityLogsDb.searchLogs(params),
      this.profileActivityLogsDb.countLogs(params)
    ]);
    const profileIdsInLogs = foundLogs.reduce((acc, log) => {
      acc.push(log.profile_id);
      if (log.target_id && !isTargetOfTypeDrop(log.type)) {
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
            : null,
        is_target_of_type_drop: isTargetOfTypeDrop(log.type)
      };
    });
    return {
      page: pageRequest.page,
      next: logCount > pageRequest.page * pageRequest.page_size,
      data: convertedData,
      count: logCount
    };
  }
}

export interface ApiProfileActivityLog
  extends Omit<ProfileActivityLog, 'contents'> {
  readonly contents: object;
  readonly profile_handle: string;
  readonly target_profile_handle: string | null;
  readonly is_target_of_type_drop: boolean;
}

export const profileActivityLogsApiService = new ProfileActivityLogsApiService(
  profileActivityLogsDb,
  profilesDb
);
