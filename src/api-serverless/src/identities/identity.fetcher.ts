import { identitiesDb, IdentitiesDb } from '../../../identities/identities.db';
import { UUID_REGEX, WALLET_REGEX } from '@/constants';
import { cicDb, CicDb } from '@/cic/cic.db';
import { collections } from '@/collections';
import { ratingsDb, RatingsDb } from '@/rates/ratings.db';
import { Alchemy } from 'alchemy-sdk';
import { getAlchemyInstance } from '../../../alchemy';
import { IdentityEntity } from '../../../entities/IIdentity';
import { RequestContext } from '../../../request.context';
import { ApiDropResolvedIdentityProfile } from '../generated/models/ApiDropResolvedIdentityProfile';
import { ApiIdentity } from '../generated/models/ApiIdentity';
import { getLevelFromScore } from '../../../profiles/profile-level';
import { ConnectionWrapper } from '../../../sql-executor';
import { ApiProfileMin } from '../generated/models/ApiProfileMin';
import { ApiProfileRepCategorySummary } from '../generated/models/ApiProfileRepCategorySummary';
import { ActivityEventTargetType } from '../../../entities/IActivityEvent';
import { ApiIdentitySubscriptionTargetAction } from '../generated/models/ApiIdentitySubscriptionTargetAction';
import {
  identitySubscriptionsDb,
  IdentitySubscriptionsDb
} from '../identity-subscriptions/identity-subscriptions.db';
import { ApiProfileClassification } from '../generated/models/ApiProfileClassification';
import { NotFoundException } from '../../../exceptions';
import { ApiCommunityMemberMinimal } from '../generated/models/ApiCommunityMemberMinimal';
import { enums } from '../../../enums';
import { ApiWaveMin } from '@/api/generated/models/ApiWaveMin';
import { ProfileProxyActionType } from '@/entities/IProfileProxyAction';
import { userGroupsService } from '@/api/community-members/user-groups.service';
import { wavesApiDb } from '@/api/waves/waves.api.db';
import { mapWaveEntityToApiWaveMin } from '@/api/waves/wave-min.mapper';

export class IdentityFetcher {
  constructor(
    private readonly identitiesDb: IdentitiesDb,
    private readonly identitySubscriptionsDb: IdentitySubscriptionsDb,
    private readonly cicDb: CicDb,
    private readonly ratingsDb: RatingsDb,
    private readonly supplyAlchemy: () => Alchemy
  ) {}

  public async getProfileIdByIdentityKeyOrThrow(
    { identityKey }: { identityKey: string },
    ctx: RequestContext
  ): Promise<string> {
    const id = await this.getProfileIdByIdentityKey({ identityKey }, ctx);
    if (!id) {
      throw new NotFoundException(
        `Profile not found for identity ${identityKey}`
      );
    }
    return id;
  }

  public async getProfileIdByIdentityKey(
    { identityKey }: { identityKey: string },
    ctx: RequestContext
  ): Promise<string | null> {
    return await this.getIdentityAndConsolidationsByIdentityKey(
      { identityKey },
      ctx
    ).then((identity) => identity?.id ?? null);
  }

  public async getIdentityAndConsolidationsByIdentityKey(
    { identityKey }: { identityKey: string },
    ctx: RequestContext
  ): Promise<ApiIdentity | null> {
    const key = identityKey.toLowerCase();
    try {
      ctx.timer?.start(
        `${this.constructor.name}->getIdentityAndConsolidationsByIdentityKey(${key})`
      );
      if (UUID_REGEX.exec(key)) {
        return this.getIdentityAndConsolidationsByProfileId(key, ctx);
      } else if (key.endsWith('.eth')) {
        return await this.getIdentityAndConsolidationsByEnsName(key, ctx);
      } else if (WALLET_REGEX.exec(key)) {
        return await this.getIdentityAndConsolidationsByWallet(key, ctx);
      }
      return await this.getIdentityAndConsolidationsByHandle(key, ctx);
    } finally {
      ctx.timer?.stop(
        `${this.constructor.name}->getIdentityAndConsolidationsByIdentityKey(${key})`
      );
    }
  }

  public async getOverviewsByIds(
    ids: string[],
    ctx: RequestContext
  ): Promise<Record<string, ApiProfileMin>> {
    const [
      identities,
      subscribedActions,
      mainStageSubscriptions,
      mainStageWins,
      artistOfPrevoteCards,
      waveCreatorIds
    ] = await Promise.all([
      this.identitiesDb.getIdentitiesByIds(ids, ctx.connection),
      this.getSubscribedActions({
        authenticatedProfileId: ctx.authenticationContext?.getActingAsId(),
        ids
      }),
      this.identitiesDb.getActiveMainStageDropIds(ids, ctx),
      this.identitiesDb.getMainStageWinnerDropIds(ids, ctx),
      this.identitiesDb.getArtistOfPrevoteCards(ids, ctx),
      this.identitiesDb.getWaveCreatorProfileIds(ids, ctx.connection)
    ]);
    const identityWaves = await this.getIdentityWavesByIdentities(
      identities,
      ctx
    );
    const notFoundProfileIds = ids.filter(
      (id) => !identities.find((p) => p.profile_id === id)
    );
    const notArchivedProfiles = identities.reduce<ApiProfileMin[]>((acc, p) => {
      const profileId = p.profile_id;
      if (profileId === null) {
        return acc;
      }
      const profile = {
        id: profileId,
        handle: p.handle,
        banner1_color: p.banner1,
        banner2_color: p.banner2,
        cic: p.cic,
        rep: p.rep,
        tdh: p.tdh,
        xtdh: p.xtdh,
        xtdh_rate: p.xtdh_rate,
        tdh_rate: p.basetdh_rate,
        level: getLevelFromScore(p.level_raw),
        pfp: p.pfp,
        archived: false,
        subscribed_actions: subscribedActions[profileId] ?? [],
        primary_address: p.primary_address,
        active_main_stage_submission_ids:
          mainStageSubscriptions[profileId] ?? [],
        winner_main_stage_drop_ids: mainStageWins[profileId] ?? [],
        artist_of_prevote_cards: artistOfPrevoteCards[profileId] ?? [],
        is_wave_creator: waveCreatorIds.has(profileId),
        identity_wave: identityWaves[profileId] ?? null
      };
      acc.push(profile);
      return acc;
    }, []);
    const archivedProfiles = await this.identitiesDb
      .getNewestVersionHandlesOfArchivedProfiles(
        notFoundProfileIds,
        ctx.connection
      )
      .then((it) =>
        it.reduce<ApiProfileMin[]>((acc, p) => {
          const profile = {
            id: p.external_id,
            handle: p.handle,
            banner1_color: p.banner1,
            banner2_color: p.banner2,
            cic: 0,
            rep: 0,
            tdh: 0,
            xtdh: 0,
            xtdh_rate: 0,
            tdh_rate: 0,
            level: 0,
            primary_address: p.primary_address,
            pfp: null,
            archived: true,
            subscribed_actions: subscribedActions[p.external_id] ?? [],
            active_main_stage_submission_ids:
              mainStageSubscriptions[p.external_id] ?? [],
            winner_main_stage_drop_ids: mainStageWins[p.external_id] ?? [],
            artist_of_prevote_cards: artistOfPrevoteCards[p.external_id] ?? [],
            is_wave_creator: waveCreatorIds.has(p.external_id),
            identity_wave: null
          };
          acc.push(profile);
          return acc;
        }, [])
      );
    return [...notArchivedProfiles, ...archivedProfiles].reduce(
      (acc, it) => {
        acc[it.id] = it;
        return acc;
      },
      {} as Record<string, ApiProfileMin>
    );
  }

  public async getDropResolvedIdentitiesByIds(
    {
      ids,
      baseProfilesById
    }: {
      ids: string[];
      baseProfilesById?: Record<string, ApiProfileMin>;
    },
    ctx: RequestContext
  ): Promise<Record<string, ApiDropResolvedIdentityProfile>> {
    const distinctIds = collections.distinct(ids);
    if (!distinctIds.length) {
      return {};
    }
    ctx.timer?.start(
      `${this.constructor.name}->getDropResolvedIdentitiesByIds`
    );
    try {
      const providedProfiles = distinctIds.reduce(
        (acc, id) => {
          const profile = baseProfilesById?.[id];
          if (profile) {
            acc[id] = profile;
          }
          return acc;
        },
        {} as Record<string, ApiProfileMin>
      );
      const missingIds = distinctIds.filter((id) => !providedProfiles[id]);
      const [fetchedProfiles, bios, topRepCategoriesRows] = await Promise.all([
        missingIds.length
          ? this.getOverviewsByIds(missingIds, ctx)
          : Promise.resolve({} as Record<string, ApiProfileMin>),
        this.cicDb.getLatestBiosByProfileIds(distinctIds, ctx),
        this.ratingsDb.getTopAbsoluteRepCategoriesByTargetIds(
          {
            targetIds: distinctIds,
            limitPerTarget: 2
          },
          ctx
        )
      ]);
      const profilesById = {
        ...providedProfiles,
        ...fetchedProfiles
      };
      const biosByProfileId = bios.reduce(
        (acc, row) => {
          acc[row.profile_id] = row.bio;
          return acc;
        },
        {} as Record<string, string>
      );
      const topRepCategoriesByProfileId = topRepCategoriesRows.reduce(
        (acc, row) => {
          const categories = acc[row.profile_id] ?? [];
          categories.push({
            category: row.category,
            rep: row.rep
          });
          acc[row.profile_id] = categories;
          return acc;
        },
        {} as Record<string, ApiProfileRepCategorySummary[]>
      );
      return distinctIds.reduce(
        (acc, id) => {
          const profile = profilesById[id];
          if (!profile) {
            return acc;
          }
          acc[id] = {
            ...profile,
            bio: biosByProfileId[id] ?? null,
            top_rep_categories: topRepCategoriesByProfileId[id] ?? []
          };
          return acc;
        },
        {} as Record<string, ApiDropResolvedIdentityProfile>
      );
    } finally {
      ctx.timer?.stop(
        `${this.constructor.name}->getDropResolvedIdentitiesByIds`
      );
    }
  }

  public async getIdentityWavesByIdentities(
    identities: Array<Pick<IdentityEntity, 'profile_id' | 'wave_id'>>,
    ctx: RequestContext
  ): Promise<Record<string, ApiWaveMin | null>> {
    const profileIdsByWaveId = identities.reduce(
      (acc, identity) => {
        if (identity.profile_id && identity.wave_id) {
          acc[identity.profile_id] = identity.wave_id;
        }
        return acc;
      },
      {} as Record<string, string>
    );
    const waveIds = Array.from(new Set(Object.values(profileIdsByWaveId)));
    if (waveIds.length === 0) {
      return {};
    }
    const readableWaveProfileId = this.getReadableWaveProfileId(ctx);
    const [groupIdsUserIsEligibleFor, pinnedWaveIds] = await Promise.all([
      this.getReadableWaveGroupIds(ctx),
      wavesApiDb.whichOfWavesArePinnedByGivenProfile(
        {
          waveIds,
          profileId: readableWaveProfileId
        },
        ctx
      )
    ]);
    const noRightToVote = this.hasNoRightToVote(ctx);
    const noRightToParticipate = this.hasNoRightToParticipate(ctx);
    const waveEntities = await wavesApiDb.findWavesByIdsEligibleForRead(
      waveIds,
      groupIdsUserIsEligibleFor,
      ctx.connection
    );
    const publicWavesById = waveEntities
      .filter((waveEntity) => waveEntity.visibility_group_id === null)
      .reduce(
        (acc, waveEntity) => {
          acc[waveEntity.id] = mapWaveEntityToApiWaveMin({
            waveEntity,
            groupIdsUserIsEligibleFor,
            pinned: pinnedWaveIds.has(waveEntity.id),
            noRightToVote,
            noRightToParticipate
          });
          return acc;
        },
        {} as Record<string, ApiWaveMin>
      );
    return Object.entries(profileIdsByWaveId).reduce(
      (acc, [profileId, waveId]) => {
        acc[profileId] = publicWavesById[waveId] ?? null;
        return acc;
      },
      {} as Record<string, ApiWaveMin | null>
    );
  }

  private async getSubscribedActions(
    {
      authenticatedProfileId,
      ids
    }: { authenticatedProfileId?: string | null; ids: string[] },
    connection?: ConnectionWrapper<any>
  ) {
    return authenticatedProfileId
      ? await this.identitySubscriptionsDb
          .findIdentitySubscriptionActionsOfTargets(
            {
              subscriber_id: authenticatedProfileId,
              target_ids: ids,
              target_type: ActivityEventTargetType.IDENTITY
            },
            connection
          )
          .then((result) =>
            Object.entries(result).reduce(
              (acc, [profileId, actions]) => {
                acc[profileId] = actions.map((it) =>
                  enums.resolveOrThrow(ApiIdentitySubscriptionTargetAction, it)
                );
                return acc;
              },
              {} as Record<string, ApiIdentitySubscriptionTargetAction[]>
            )
          )
      : {};
  }

  private async getReadableWaveGroupIds(
    ctx: RequestContext
  ): Promise<string[]> {
    const readableWaveProfileId = this.getReadableWaveProfileId(ctx);
    if (!readableWaveProfileId) {
      return [];
    }
    return userGroupsService.getGroupsUserIsEligibleFor(
      readableWaveProfileId,
      ctx.timer
    );
  }

  private getReadableWaveProfileId(ctx: RequestContext): string | null {
    const authenticationContext = ctx.authenticationContext;
    if (!authenticationContext?.hasRightsTo(ProfileProxyActionType.READ_WAVE)) {
      return null;
    }
    return authenticationContext.getActingAsId();
  }

  private hasNoRightToVote(ctx: RequestContext): boolean {
    const authenticationContext = ctx.authenticationContext;
    return !!(
      authenticationContext?.isAuthenticatedAsProxy() &&
      !authenticationContext.activeProxyActions[
        ProfileProxyActionType.RATE_WAVE_DROP
      ]
    );
  }

  private hasNoRightToParticipate(ctx: RequestContext): boolean {
    const authenticationContext = ctx.authenticationContext;
    return !!(
      authenticationContext?.isAuthenticatedAsProxy() &&
      !authenticationContext.activeProxyActions[
        ProfileProxyActionType.CREATE_DROP_TO_WAVE
      ]
    );
  }

  private async getIdentityAndConsolidationsByHandle(
    handle: string,
    ctx: RequestContext
  ): Promise<ApiIdentity | null> {
    const identity = await this.identitiesDb.getIdentityByHandle(handle, ctx);
    if (!identity) {
      return null;
    }
    return await this.mapToApiIdentity(identity, handle, ctx);
  }

  private async getIdentityAndConsolidationsByProfileId(
    id: string,
    ctx: RequestContext
  ): Promise<ApiIdentity | null> {
    const identity = await this.identitiesDb.getIdentityByProfileId(
      id,
      ctx.connection
    );
    if (!identity) {
      return null;
    }
    return await this.mapToApiIdentity(identity, id, ctx);
  }

  private async getIdentityAndConsolidationsByEnsName(
    query: string,
    ctx: RequestContext
  ): Promise<ApiIdentity | null> {
    const wallet = await this.supplyAlchemy().core.resolveName(query);
    if (!wallet) {
      return null;
    }
    await this.getIdentityAndConsolidationsByWallet(wallet, ctx);
    const identity = await this.getIdentityAndConsolidationsByWallet(
      wallet,
      ctx
    );
    if (!identity) {
      return null;
    }

    return { ...identity, query: query };
  }

  private async getIdentityAndConsolidationsByWallet(
    query: string,
    ctx: RequestContext
  ): Promise<ApiIdentity | null> {
    const wallet = query.toLowerCase();
    const identity = await this.identitiesDb.getIdentityByWallet(
      wallet,
      ctx.connection
    );
    if (!identity) {
      return {
        id: null,
        handle: null,
        normalised_handle: null,
        cic: 0,
        rep: 0,
        tdh: 0,
        tdh_rate: 0,
        xtdh: 0,
        xtdh_rate: 0,
        level: 0,
        display: query,
        primary_wallet: query,
        pfp: null,
        banner1: null,
        banner2: null,
        wallets: [
          {
            wallet: query,
            display: query,
            tdh: 0
          }
        ],
        query: query,
        classification: ApiProfileClassification.Pseudonym,
        sub_classification: null,
        consolidation_key: query,
        active_main_stage_submission_ids: [],
        winner_main_stage_drop_ids: [],
        artist_of_prevote_cards: [],
        is_wave_creator: false,
        identity_wave: null
      };
    }
    return await this.mapToApiIdentity(identity, query, ctx);
  }

  private async getWalletTdhBlockNoAndConsolidatedWallets(
    wallet: string,
    ctx: RequestContext
  ): Promise<{
    blockNo: number;
    consolidation_display: string;
  }> {
    const normalisedAddress = wallet.toLowerCase();
    if (!WALLET_REGEX.exec(normalisedAddress)) {
      return {
        blockNo: 0,
        consolidation_display: wallet
      };
    }
    return this.identitiesDb
      .getConsolidationInfoForAddress(normalisedAddress, ctx.connection)
      .then((resultRows) => {
        if (!resultRows.length) {
          return {
            blockNo: 0,
            consolidation_display: wallet
          };
        }
        const result = resultRows[0];
        if (
          !result.wallets
            .map((it) => it.toLowerCase())
            .includes(normalisedAddress)
        ) {
          result.wallets.push(normalisedAddress);
        }
        return {
          blockNo: result.blockNo,
          consolidation_display: result.consolidation_display ?? wallet,
          balance: result.balance
        };
      });
  }

  private async mapToApiIdentity(
    identity: IdentityEntity,
    query: string,
    ctx: RequestContext
  ): Promise<ApiIdentity> {
    const { blockNo, consolidation_display } =
      await this.getWalletTdhBlockNoAndConsolidatedWallets(
        identity.primary_address,
        ctx
      );
    const consolidatedWallets = identity.consolidation_key.split(`-`);
    const walletTdhs = await this.identitiesDb.getWalletsTdhs(
      {
        wallets: consolidatedWallets,
        blockNo
      },
      ctx
    );
    const [
      wallets,
      mainStageDropIds,
      mainStageWinnerDrops,
      artistOfPrevoteCards,
      waveCreatorIds
    ] = await Promise.all([
      this.identitiesDb.getPrediscoveredEnsNames(consolidatedWallets, ctx),
      this.identitiesDb
        .getActiveMainStageDropIds(
          identity.profile_id ? [identity.profile_id] : [],
          ctx
        )
        .then((it) =>
          identity.profile_id ? (it[identity.profile_id] ?? []) : []
        ),
      this.identitiesDb
        .getMainStageWinnerDropIds(
          identity.profile_id ? [identity.profile_id] : [],
          ctx
        )
        .then((it) =>
          identity.profile_id ? (it[identity.profile_id] ?? []) : []
        ),
      this.identitiesDb
        .getArtistOfPrevoteCards(
          identity.profile_id ? [identity.profile_id] : [],
          ctx
        )
        .then((it) =>
          identity.profile_id ? (it[identity.profile_id] ?? []) : []
        ),
      this.identitiesDb.getWaveCreatorProfileIds(
        identity.profile_id ? [identity.profile_id] : [],
        ctx.connection
      )
    ]);
    const classification = identity.classification
      ? (enums.resolve(
          ApiProfileClassification,
          identity.classification as string
        ) ?? ApiProfileClassification.Pseudonym)
      : ApiProfileClassification.Pseudonym;
    const identityWave = identity.profile_id
      ? ((
          await this.getIdentityWavesByIdentities(
            [
              {
                profile_id: identity.profile_id,
                wave_id: identity.wave_id
              }
            ],
            ctx
          )
        )[identity.profile_id] ?? null)
      : null;
    return {
      id: identity.profile_id,
      handle: identity.handle,
      normalised_handle: identity.normalised_handle,
      cic: identity.cic,
      rep: identity.rep,
      tdh: identity.tdh,
      tdh_rate: identity.basetdh_rate,
      xtdh: identity.xtdh,
      xtdh_rate: identity.xtdh_rate,
      level: getLevelFromScore(identity.level_raw),
      display: consolidation_display,
      primary_wallet: identity.primary_address,
      pfp: identity.pfp,
      banner1: identity.banner1,
      banner2: identity.banner2,
      wallets: wallets.map((it) => ({
        wallet: it.address,
        display: it.ens ?? it.address,
        tdh: walletTdhs[it.address.toLowerCase()] ?? 0
      })),
      classification,
      sub_classification: identity.sub_classification,
      consolidation_key: identity.consolidation_key,
      query: query,
      active_main_stage_submission_ids: mainStageDropIds,
      winner_main_stage_drop_ids: mainStageWinnerDrops,
      artist_of_prevote_cards: artistOfPrevoteCards,
      is_wave_creator: identity.profile_id
        ? waveCreatorIds.has(identity.profile_id)
        : false,
      identity_wave: identityWave
    };
  }

  async searchCommunityMemberMinimalsOfClosestMatches({
    param,
    onlyProfileOwners,
    limit
  }: {
    param: string;
    onlyProfileOwners: boolean;
    limit: number;
  }): Promise<ApiCommunityMemberMinimal[]> {
    if (param.length < 3 || param.length > 100) {
      return [];
    }
    if (WALLET_REGEX.exec(param)) {
      const communityMember = await this.searchCommunityMemberByWallet(
        param,
        onlyProfileOwners
      );
      return communityMember ? [communityMember] : [];
    } else {
      const membersByHandles =
        await this.identitiesDb.searchCommunityMembersWhereHandleLike({
          handle: param,
          limit: limit * 3
        });
      const profilesByEnsNames =
        await this.identitiesDb.searchCommunityMembersWhereEnsLike({
          ensCandidate: param,
          onlyProfileOwners,
          limit: limit * 3
        });
      const dedupedMembers: (IdentityEntity & { ens?: string | null })[] = [];
      const seenProfKeys = new Set<string>();
      for (const prof of [...membersByHandles, ...profilesByEnsNames]) {
        const profKey = String(
          prof.consolidation_key ?? prof.profile_id ?? prof.primary_address
        );
        if (seenProfKeys.has(profKey)) {
          continue;
        }
        seenProfKeys.add(profKey);
        dedupedMembers.push(prof);
      }

      const members = dedupedMembers
        .map((member) => ({
          member,
          rank: this.getCommunityMemberSearchRank(member, param)
        }))
        .sort((left, right) =>
          this.compareCommunityMemberSearchMatches(left, right)
        )
        .slice(0, limit)
        .map(({ member }) => member);
      return members.map((member) => {
        return {
          profile_id: member.profile_id,
          handle: member.handle,
          normalised_handle: member.normalised_handle,
          primary_wallet: member.primary_address,
          tdh: +member.tdh,
          level: getLevelFromScore(+member.level_raw),
          cic_rating: +member.cic,
          display: member.handle ?? member.ens ?? member.primary_address,
          wallet: member.primary_address,
          pfp: member.pfp
        };
      });
    }
  }

  private compareCommunityMemberSearchMatches(
    left: {
      member: IdentityEntity & { ens?: string | null };
      rank: ReturnType<IdentityFetcher['getCommunityMemberSearchRank']>;
    },
    right: {
      member: IdentityEntity & { ens?: string | null };
      rank: ReturnType<IdentityFetcher['getCommunityMemberSearchRank']>;
    }
  ): number {
    const leftRank = left.rank;
    const rightRank = right.rank;

    if (leftRank.handleMatch !== rightRank.handleMatch) {
      return rightRank.handleMatch - leftRank.handleMatch;
    }
    if (leftRank.ensMatch !== rightRank.ensMatch) {
      return rightRank.ensMatch - leftRank.ensMatch;
    }
    const leftBestIndex = Math.max(leftRank.handleIndex, leftRank.ensIndex);
    const rightBestIndex = Math.max(rightRank.handleIndex, rightRank.ensIndex);
    if (leftBestIndex !== rightBestIndex) {
      return rightBestIndex - leftBestIndex;
    }
    if (leftRank.handleLength !== rightRank.handleLength) {
      return rightRank.handleLength - leftRank.handleLength;
    }
    if (leftRank.hasNonAutoHandle !== rightRank.hasNonAutoHandle) {
      return rightRank.hasNonAutoHandle - leftRank.hasNonAutoHandle;
    }
    return Number(right.member.tdh) - Number(left.member.tdh);
  }

  private getCommunityMemberSearchRank(
    member: IdentityEntity & { ens?: string | null },
    param: string
  ) {
    const paramNorm = param.toLowerCase();
    const normalisedHandle =
      member.normalised_handle ?? member.handle?.toLowerCase() ?? null;
    const normalisedEns = member.ens?.toLowerCase() ?? null;

    const handleMatch = this.getSearchFieldMatchStrength(
      normalisedHandle,
      paramNorm
    );
    const ensMatch = this.getSearchFieldMatchStrength(normalisedEns, paramNorm);
    const handleIndex =
      normalisedHandle?.includes(paramNorm) === true
        ? 1000 - normalisedHandle.indexOf(paramNorm)
        : 0;
    const ensIndex =
      normalisedEns?.includes(paramNorm) === true
        ? 1000 - normalisedEns.indexOf(paramNorm)
        : 0;
    const handleLength = normalisedHandle ? 1000 - normalisedHandle.length : 0;
    const hasNonAutoHandle =
      member.handle && !member.handle.toLowerCase().startsWith('id-0x') ? 1 : 0;

    return {
      handleMatch,
      ensMatch,
      handleIndex,
      ensIndex,
      handleLength,
      hasNonAutoHandle
    };
  }

  private getSearchFieldMatchStrength(
    value: string | null,
    query: string
  ): number {
    if (!value) {
      return 0;
    }
    if (value === query) {
      return 300;
    }
    if (value.startsWith(query)) {
      return 200;
    }
    if (value.includes(query)) {
      return 100;
    }
    return 0;
  }

  private async searchCommunityMemberByWallet(
    wallet: string,
    onlyProfileOwners: boolean
  ): Promise<ApiCommunityMemberMinimal | null> {
    const identity =
      await identityFetcher.getIdentityAndConsolidationsByIdentityKey(
        { identityKey: wallet },
        {}
      );
    if (!identity || (onlyProfileOwners && !identity.id)) {
      return null;
    }
    let display = identity.display;
    if (!display && !identity.id) {
      return null;
    }
    if (!display) {
      const wallets = await this.identitiesDb.getPrediscoveredEnsNames(
        [identity.primary_wallet],
        {}
      );
      const walletResp = wallets.at(0);
      display = walletResp?.ens ?? wallet;
    }
    return {
      profile_id: identity.id,
      handle: identity.handle,
      normalised_handle: identity.normalised_handle,
      primary_wallet: identity.primary_wallet,
      tdh: identity.tdh,
      level: identity.level,
      cic_rating: identity.cic,
      display: display,
      pfp: identity.pfp,
      wallet
    };
  }
}

export const identityFetcher = new IdentityFetcher(
  identitiesDb,
  identitySubscriptionsDb,
  cicDb,
  ratingsDb,
  getAlchemyInstance
);
