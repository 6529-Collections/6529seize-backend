import {
  profileActivityLogsDb,
  ProfileActivityLogsDb,
  ProfileLogSearchParams
} from '../../../profileActivityLogs/profile-activity-logs.db';
import {
  ProfileActivityLog,
  ProfileActivityLogTargetType,
  ProfileActivityLogType
} from '../../../entities/IProfileActivityLog';
import { Page, PageRequest } from '../page-request';
import { profilesDb, ProfilesDb } from '../../../profiles/profiles.db';

export class ProfileActivityLogsApiService {
  constructor(
    private readonly profileActivityLogsDb: ProfileActivityLogsDb,
    private readonly profilesDb: ProfilesDb
  ) {}

  async getProfileActivityLogs({
    profileId,
    order,
    pageRequest,
    targetId,
    logType,
    targetType
  }: {
    profileId?: string;
    targetId?: string;
    targetType?: ProfileActivityLogTargetType;
    logType?: ProfileActivityLogType;
    pageRequest: PageRequest;
    order: 'desc' | 'asc';
  }): Promise<Page<ApiProfileActivtyLog>> {
    const params: ProfileLogSearchParams = {
      order,
      pageRequest
    };

    if (profileId) {
      params.profile_id = profileId;
      if (!targetId) {
        params.profileIdAndTargetIdInOrCondition = true;
      }
    }
    if (targetId) {
      params.target_id = targetId;
    }
    if (targetType) {
      params.target_type = targetType;
    }
    if (logType) {
      params.type = logType;
    }
    const foundLogs = await this.profileActivityLogsDb.searchLogs(params);
    const profileIdsInLogs = foundLogs.data.reduce((acc, log) => {
      acc.push(log.profile_id);
      if (
        log.target_type === ProfileActivityLogTargetType.PROFILE_ID &&
        log.target_id
      ) {
        acc.push(log.target_id);
      }
      return acc;
    }, [] as string[]);
    const profilesHandlesByIds = await this.profilesDb.getProfileHandlesByIds(
      profileIdsInLogs
    );
    const convertedData = foundLogs.data.map((log) => ({
      ...log,
      contents: JSON.parse(log.contents),
      profile_handle: profilesHandlesByIds[log.profile_id]!,
      target_profile_handle:
        log.target_type === ProfileActivityLogTargetType.PROFILE_ID
          ? profilesHandlesByIds[log.target_id!]
          : null
    }));
    return {
      ...foundLogs,
      data: convertedData
    };
  }
}

export interface ApiProfileActivtyLog
  extends Omit<ProfileActivityLog, 'contents'> {
  readonly contents: object;
  readonly profile_handle: string;
  readonly target_profile_handle: string | null;
}

export const profileActivityLogsApiService = new ProfileActivityLogsApiService(
  profileActivityLogsDb,
  profilesDb
);
