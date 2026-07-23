import {
  userGroupsService,
  UserGroupsService
} from '@/api/community-members/user-groups.service';
import { ApiWaveMentionSearchResult } from '@/api/generated/models/ApiWaveMentionSearchResult';
import {
  getGroupsUserIsEligibleForReadContext,
  getWaveReadContextProfileId
} from '@/api/waves/wave-access.helpers';
import { wavesApiDb, WavesApiDb } from '@/api/waves/waves.api.db';
import { ForbiddenException, NotFoundException } from '@/exceptions';
import { identitiesDb, IdentitiesDb } from '@/identities/identities.db';
import { RequestContext } from '@/request.context';

export class WaveMentionSearchApiService {
  constructor(
    private readonly identitiesDb: IdentitiesDb,
    private readonly wavesApiDb: WavesApiDb,
    private readonly userGroupsService: UserGroupsService
  ) {}

  public async search(
    {
      waveId,
      handle,
      limit
    }: {
      readonly waveId: string;
      readonly handle: string;
      readonly limit: number;
    },
    ctx: RequestContext
  ): Promise<ApiWaveMentionSearchResult[]> {
    const eligibleGroupIds = await getGroupsUserIsEligibleForReadContext(
      this.userGroupsService,
      ctx
    );
    const wave = await this.wavesApiDb
      .findWavesByIds([waveId], eligibleGroupIds, ctx.connection)
      .then((waves) => waves.at(0) ?? null);
    if (!wave) {
      throw new NotFoundException(`Wave ${waveId} not found`);
    }

    const eligibility = wave.visibility_group_id
      ? await this.userGroupsService.getSqlAndParamsByGroupId(
          wave.visibility_group_id,
          ctx
        )
      : null;
    if (wave.visibility_group_id && !eligibility) {
      return [];
    }

    return await this.identitiesDb.searchWaveMentionCandidates(
      {
        handle,
        limit,
        excludedProfileId: getWaveReadContextProfileId(
          ctx.authenticationContext
        )
      },
      eligibility,
      ctx
    );
  }

  public async searchDraft(
    {
      visibilityGroupId,
      handle,
      limit
    }: {
      readonly visibilityGroupId: string | null;
      readonly handle: string;
      readonly limit: number;
    },
    ctx: RequestContext
  ): Promise<ApiWaveMentionSearchResult[]> {
    const actingProfileId = ctx.authenticationContext?.getActingAsId() ?? null;
    if (!actingProfileId) {
      throw new ForbiddenException(`Please create a profile first`);
    }

    const eligibility = visibilityGroupId
      ? await this.userGroupsService.getSqlAndParamsByGroupId(
          visibilityGroupId,
          ctx
        )
      : null;
    if (visibilityGroupId && !eligibility) {
      return [];
    }

    return await this.identitiesDb.searchWaveMentionCandidates(
      {
        handle,
        limit,
        excludedProfileId: actingProfileId
      },
      eligibility,
      ctx
    );
  }
}

export const waveMentionSearchApiService = new WaveMentionSearchApiService(
  identitiesDb,
  wavesApiDb,
  userGroupsService
);
