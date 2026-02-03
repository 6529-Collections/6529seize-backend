import { identitiesDb, IdentitiesDb } from '../../../identities/identities.db';
import { UUID_REGEX, WALLET_REGEX } from '@/constants';
import { Alchemy } from 'alchemy-sdk';
import { getAlchemyInstance } from '../../../alchemy';
import { IdentityEntity } from '../../../entities/IIdentity';
import { RequestContext } from '../../../request.context';
import { ApiIdentity } from '../generated/models/ApiIdentity';
import { getLevelFromScore } from '../../../profiles/profile-level';
import { ConnectionWrapper } from '../../../sql-executor';
import { ApiProfileMin } from '../generated/models/ApiProfileMin';
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

export class IdentityFetcher {
  constructor(
    private readonly identitiesDb: IdentitiesDb,
    private readonly identitySubscriptionsDb: IdentitySubscriptionsDb,
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
      waveCreatorIds
    ] = await Promise.all([
      this.identitiesDb.getIdentitiesByIds(ids, ctx.connection),
      this.getSubscribedActions({
        authenticatedProfileId: ctx.authenticationContext?.getActingAsId(),
        ids
      }),
      this.identitiesDb.getActiveMainStageDropIds(ids, ctx),
      this.identitiesDb.getMainStageWinnerDropIds(ids, ctx),
      this.identitiesDb.getWaveCreatorProfileIds(ids, ctx.connection)
    ]);
    const notFoundProfileIds = ids.filter(
      (id) => !identities.find((p) => p.profile_id === id)
    );
    const notArchivedProfiles = identities.map<ApiProfileMin>((p) => ({
      id: p.profile_id!,
      handle: p.handle,
      banner1_color: p.banner1,
      banner2_color: p.banner2,
      cic: p.cic,
      rep: p.rep,
      tdh: p.tdh,
      xtdh: p.xtdh,
      xtdh_rate: p.xtdh_rate,
      produced_xtdh: p.produced_xtdh,
      granted_xtdh: p.granted_xtdh,
      tdh_rate: p.basetdh_rate,
      level: getLevelFromScore(p.level_raw),
      pfp: p.pfp,
      archived: false,
      subscribed_actions: subscribedActions[p.profile_id!] ?? [],
      primary_address: p.primary_address,
      active_main_stage_submission_ids:
        mainStageSubscriptions[p.profile_id!] ?? [],
      winner_main_stage_drop_ids: mainStageWins[p.profile_id!] ?? [],
      is_wave_creator: waveCreatorIds.has(p.profile_id!)
    }));
    const archivedProfiles = await this.identitiesDb
      .getNewestVersionHandlesOfArchivedProfiles(
        notFoundProfileIds,
        ctx.connection
      )
      .then((it) =>
        it.map<ApiProfileMin>((p) => ({
          id: p.external_id,
          handle: p.handle,
          banner1_color: p.banner1,
          banner2_color: p.banner2,
          cic: 0,
          rep: 0,
          tdh: 0,
          xtdh: 0,
          xtdh_rate: 0,
          granted_xtdh: 0,
          produced_xtdh: 0,
          tdh_rate: 0,
          level: 0,
          primary_address: p.primary_address,
          pfp: null,
          archived: true,
          subscribed_actions: subscribedActions[p.external_id] ?? [],
          active_main_stage_submission_ids:
            mainStageSubscriptions[p.external_id] ?? [],
          winner_main_stage_drop_ids: mainStageWins[p.external_id] ?? [],
          is_wave_creator: waveCreatorIds.has(p.external_id)
        }))
      );
    return [...notArchivedProfiles, ...archivedProfiles].reduce(
      (acc, it) => {
        acc[it.id] = it;
        return acc;
      },
      {} as Record<string, ApiProfileMin>
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
        is_wave_creator: false
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
    const [wallets, mainStageDropIds, mainStageWinnerDrops, waveCreatorIds] =
      await Promise.all([
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
      is_wave_creator: identity.profile_id
        ? waveCreatorIds.has(identity.profile_id)
        : false
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
      const members = [...membersByHandles, ...profilesByEnsNames]
        .reduce(
          (acc, prof) => {
            const profDisplay = prof.handle ?? prof.ens ?? prof.primary_address;
            if (
              !acc.find((it) => {
                const itDisplay = it.handle ?? it.ens ?? it.primary_address;
                return itDisplay === profDisplay;
              })
            ) {
              acc.push(prof);
            }
            return acc;
          },
          [] as (IdentityEntity & { ens: string })[]
        )
        .sort((a, d) => {
          if (a.handle && !d.handle) {
            return -1;
          } else if (!a.handle && d.handle) {
            return 1;
          }
          return d.tdh - a.tdh;
        })
        .slice(0, limit);
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
  getAlchemyInstance
);
