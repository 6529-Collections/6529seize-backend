import { identitiesDb, IdentitiesDb } from '../../../identities/identities.db';
import { UUID_REGEX, WALLET_REGEX } from '../../../constants';
import { Alchemy } from 'alchemy-sdk';
import { getAlchemyInstance } from '../../../alchemy';
import { IdentityEntity } from '../../../entities/IIdentity';
import { RequestContext } from '../../../request.context';
import { ApiIdentity } from '../generated/models/ApiIdentity';
import { getLevelFromScore } from '../../../profiles/profile-level';
import { ConnectionWrapper } from '../../../sql-executor';
import { ApiProfileMin } from '../generated/models/ApiProfileMin';
import { ActivityEventTargetType } from '../../../entities/IActivityEvent';
import { resolveEnumOrThrow } from '../../../helpers';
import { ApiIdentitySubscriptionTargetAction } from '../generated/models/ApiIdentitySubscriptionTargetAction';
import {
  identitySubscriptionsDb,
  IdentitySubscriptionsDb
} from '../identity-subscriptions/identity-subscriptions.db';

export class IdentityFetcher {
  constructor(
    private readonly identitiesDb: IdentitiesDb,
    private readonly identitySubscriptionsDb: IdentitySubscriptionsDb,
    private readonly supplyAlchemy: () => Alchemy
  ) {}

  public async getIdentityAndConsolidationsByIdentityKey(
    { identityKey }: { identityKey: string },
    ctx: RequestContext
  ): Promise<ApiIdentity | null> {
    if (UUID_REGEX.exec(identityKey)) {
      return this.getIdentityAndConsolidationsByProfileId(identityKey, ctx);
    } else if (identityKey.endsWith('.eth')) {
      return await this.getIdentityAndConsolidationsByEnsName(identityKey, ctx);
    } else if (WALLET_REGEX.exec(identityKey)) {
      return await this.getIdentityAndConsolidationsByWallet(identityKey, ctx);
    }
    return await this.getIdentityAndConsolidationsByHandle(identityKey, ctx);
  }

  public async getOverviewsByIds(
    ids: string[],
    ctx: RequestContext
  ): Promise<Record<string, ApiProfileMin>> {
    const [identities, subscribedActions] = await Promise.all([
      this.identitiesDb.getIdentitiesByIds(ids, ctx.connection),
      this.getSubscribedActions({
        authenticatedProfileId: ctx.authenticationContext?.getActingAsId(),
        ids
      })
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
      level: getLevelFromScore(p.level_raw),
      pfp: p.pfp,
      archived: true,
      subscribed_actions: subscribedActions[p.profile_id!] ?? []
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
          level: 0,
          pfp: null,
          archived: true,
          subscribed_actions: subscribedActions[p.external_id] ?? []
        }))
      );
    return [...notArchivedProfiles, ...archivedProfiles].reduce((acc, it) => {
      acc[it.id] = it;
      return acc;
    }, {} as Record<string, ApiProfileMin>);
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
            Object.entries(result).reduce((acc, [profileId, actions]) => {
              acc[profileId] = actions.map((it) =>
                resolveEnumOrThrow(ApiIdentitySubscriptionTargetAction, it)
              );
              return acc;
            }, {} as Record<string, ApiIdentitySubscriptionTargetAction[]>)
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
        query: query
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
    const wallets = await this.identitiesDb.getPrediscoveredEnsNames(
      consolidatedWallets,
      ctx
    );
    return {
      id: identity.profile_id,
      handle: identity.handle,
      normalised_handle: identity.normalised_handle,
      cic: identity.cic,
      rep: identity.rep,
      tdh: identity.tdh,
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
      query: query
    };
  }
}

export const identityFetcher = new IdentityFetcher(
  identitiesDb,
  identitySubscriptionsDb,
  getAlchemyInstance
);
