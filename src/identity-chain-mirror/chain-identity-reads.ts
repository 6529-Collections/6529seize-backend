import {
  ChainGatewayClient,
  chainGatewayClient
} from '@/chain-gateway/chain-gateway.client';
import { ChainIdentity } from '@/chain-gateway/chain-gateway.types';
import { appFeatures } from '@/app-features';
import { IdentityEntity } from '@/entities/IIdentity';
import { ProfileClassification } from '@/entities/IProfile';
import { enums } from '@/enums';
import { identitiesDb, IdentitiesDb } from '@/identities/identities.db';
import { Logger } from '@/logging';
import {
  identityChainMirrorDb,
  IdentityChainMirrorDb
} from './identity-chain-mirror.db';
import {
  consolidationKeyOf,
  isPlaceholderHandle,
  placeholderHandle
} from './identity-plan';
import { DbPoolName } from '@/db-query.options';
import { isAnotherNodesToGive } from './mirror-errors';
import { ProfileIdChoice, ProfileIdChoiceDb } from './profile-ids';
import {
  decodeProfileDoc,
  ProfileDocFields,
  toProfileDocFields
} from './profile-doc';

const logger = Logger.get('CHAIN_IDENTITY_READS');

type Gateway = Pick<
  ChainGatewayClient,
  | 'getIdentityByWallet'
  | 'getIdentityByHandle'
  | 'getIdentityByPrincipal'
  | 'getIdentityByLegacyProfileId'
  | 'getProfileDoc'
  | 'getHandle'
  | 'getMembership'
  | 'getHead'
  | 'getImportedIdentity'
>;

/**
 * The identity mirror's tables the reads ask: which chain they are of, and
 * what its choice of a profile id reads. No write is in the type, so a read
 * can't write the mirror's tables.
 */
type MirrorDb = ProfileIdChoiceDb &
  Pick<IdentityChainMirrorDb, 'mirrorChainState'>;

function heightOf(value: unknown): number | null {
  const n = Number(value);
  return value === null || value === undefined || !Number.isSafeInteger(n)
    ? null
    : n;
}

type MappingDb = Pick<
  IdentityChainMirrorDb,
  'profileIdOfPrincipal' | 'principalOfProfile'
>;

type RowsDb = Pick<
  IdentitiesDb,
  'getIdentityByWallet' | 'getIdentityByProfileId' | 'getIdentityByHandle'
>;

/** Step two: identity lookups read the 6529 chain (FEATURE_IDENTITY_READS_FROM_CHAIN). */
export function identityReadsFromChain(): boolean {
  return appFeatures.isIdentityReadsFromChainEnabled();
}

function toNumber(value: string | number | null | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Identity lookups by wallet, handle and 6529.io profile id, read from the
 * 6529 chain through the gateway and shaped as 6529.io's identity rows, so
 * the identity fetcher and login keep their answers' shape. The chain gives
 * the wallets, handle, primary wallet, profile document, REP, NIC and level;
 * TDH and xTDH (the TDH loops') and the profile id mapping come from
 * 6529.io's index tables, which the identity mirror rebuilds from the chain.
 * A profile or wallet the chain does not hold (a profile that was never
 * imported) is answered from those tables as before.
 */
export class ChainIdentityReads {
  /**
   * The height the import ended at, by network, once it completed there
   * (it doesn't change then; a relaunch is another network).
   */
  private readonly importsDone = new Map<string, { done: number | null }>();

  constructor(
    private readonly gateway: Gateway = chainGatewayClient,
    private readonly mapping: MappingDb = identityChainMirrorDb,
    private readonly rows: RowsDb = identitiesDb,
    private readonly mirror: MirrorDb = identityChainMirrorDb
  ) {}

  /**
   * The 6529.io profile id the identity's rows use: its mapping, else the
   * id the identity mirror will store for it, chosen as the mirror chooses
   * (ProfileIdChoice, read only: legacy id, the founding wallet's
   * placeholder when the mirror's own bindings say it is that wallet's
   * first identity, else the derived id). Null while the mirror's tables
   * aren't of the chain the gateway serves now or haven't listed the
   * placeholder profiles, or while the choice can't be made from the
   * mirror's own state: the identity is then answered as none, never with
   * an id the mirror won't store.
   */
  async profileIdOf(identity: ChainIdentity): Promise<string | null> {
    const principalId = identity.principalId.toLowerCase();
    const network = await this.mirroredNetwork();
    let profileId: string | null = null;
    if (network !== false) {
      profileId = await this.mapping.profileIdOfPrincipal(principalId);
      if (profileId === null) {
        let chosen: string | null = null;
        let failure: { error: unknown } | null = null;
        try {
          chosen = await this.chosenProfileId(identity, network);
        } catch (error) {
          failure = { error };
        }
        // The mirror may have mapped it meanwhile (taking the placeholder
        // the choice then no longer sees as unmapped): its mapping wins,
        // read on the writer, as a replica may not have it yet. Only with
        // no mapping there does the choice, or its failure, stand.
        const mapped = await this.mapping.profileIdOfPrincipal(
          principalId,
          undefined,
          { forcePool: DbPoolName.WRITE }
        );
        if (mapped !== null) profileId = mapped;
        else if (failure) throw failure.error;
        else profileId = chosen;
      }
    }
    if (profileId === null) {
      logger.debug(
        `[IDENTITY ${principalId} NOT PLACED YET] [ANSWERED AS NONE UNTIL THE MIRROR CHOOSES ITS PROFILE ID]`
      );
    }
    return profileId;
  }

  /**
   * The network the gateway serves (null when it names none) when the
   * mirror's tables are of it, as IdentityChainLookups checks, and its
   * placeholder profiles are listed; false otherwise (across a relaunch the
   * tables are the old chain's until the mirror has run on the new one).
   */
  private async mirroredNetwork(): Promise<string | null | false> {
    const [state, head] = await Promise.all([
      this.mirror.mirrorChainState(),
      this.gateway.getHead()
    ]);
    const network = head.network?.toLowerCase() ?? null;
    if (!state || state.placeholdersAt === null) return false;
    if (network !== null && state.chainId !== network) return false;
    return network;
  }

  /**
   * The mirror's choice for an identity it hasn't mapped, as its run would
   * make it now, once the import is complete; null while it can't be made
   * from the mirror's own state.
   */
  private async chosenProfileId(
    identity: ChainIdentity,
    network: string | null
  ): Promise<string | null> {
    const imported = await this.importDone(network);
    if (!imported) return null;
    return await new ProfileIdChoice(
      this.gateway,
      this.mirror,
      imported.done
    ).readOnlyProfileId(identity);
  }

  /** The height the import ended at, once it completed; else null. */
  private async importDone(
    network: string | null
  ): Promise<{ done: number | null } | null> {
    const kept = network === null ? undefined : this.importsDone.get(network);
    if (kept) return kept;
    const membership = await this.gateway.getMembership();
    const imported = membership?.import as
      | { completed?: boolean; doneHeight?: unknown }
      | undefined;
    if (!imported?.completed) return null;
    const done = { done: heightOf(imported.doneHeight) };
    if (network !== null) this.importsDone.set(network, done);
    return done;
  }

  private async docOf(
    identity: ChainIdentity
  ): Promise<ProfileDocFields | null> {
    const cid = identity.profile?.docCid;
    if (!cid) return null;
    try {
      const bytes = await this.gateway.getProfileDoc(cid);
      return bytes ? toProfileDocFields(decodeProfileDoc(bytes)) : null;
    } catch (error) {
      logger.warn(
        `[PROFILE DOC ${cid} OF ${identity.principalId} UNREADABLE] ${(error as Error)?.message ?? error}`
      );
      return null;
    }
  }

  /**
   * A chain identity as a 6529.io identity row; null while its profile id
   * can't be chosen yet (answered as no identity).
   */
  async toIdentityEntity(
    identity: ChainIdentity
  ): Promise<IdentityEntity | null> {
    const wallets = identity.wallets.map((it) => it.toLowerCase());
    const primary = (
      identity.primary ??
      identity.anchor ??
      wallets[0]
    ).toLowerCase();
    const [profileId, doc] = await Promise.all([
      this.profileIdOf(identity),
      this.docOf(identity)
    ]);
    if (profileId === null) return null;
    const indexRow = await this.rows.getIdentityByProfileId(profileId);
    let handle: string;
    if (identity.handle) {
      const display = doc?.displayName;
      handle =
        display?.toLowerCase() === identity.handle.toLowerCase()
          ? display
          : identity.handle;
    } else if (indexRow?.handle && isPlaceholderHandle(indexRow.handle)) {
      handle = indexRow.handle;
    } else {
      handle = placeholderHandle(primary);
    }
    const rep = toNumber(identity.rep?.total);
    const tdh = toNumber(indexRow?.tdh);
    const xtdh = toNumber(indexRow?.xtdh);
    return {
      consolidation_key: consolidationKeyOf(wallets),
      profile_id: profileId,
      primary_address: primary,
      handle,
      normalised_handle: handle.toLowerCase(),
      tdh,
      rep,
      cic: toNumber(identity.nic?.total),
      // The chain's level is REP plus TDH; xTDH is not part of it.
      level_raw: identity.level ? toNumber(identity.level.raw) : rep + tdh,
      pfp: doc?.pfp ?? null,
      banner1: doc?.banner1 ?? null,
      banner2: doc?.banner2 ?? null,
      classification: doc?.classification
        ? (enums.resolve(ProfileClassification, doc.classification) ?? null)
        : null,
      sub_classification: doc?.subClassification ?? null,
      xtdh,
      xtdh_rate: toNumber(indexRow?.xtdh_rate),
      basetdh_rate: toNumber(indexRow?.basetdh_rate),
      produced_xtdh: toNumber(indexRow?.produced_xtdh),
      granted_xtdh: toNumber(indexRow?.granted_xtdh)
    };
  }

  private isLive(identity: ChainIdentity | null): identity is ChainIdentity {
    return (
      !!identity &&
      !identity.mergedInto &&
      identity.wallets.length > 0 &&
      (!identity.status || identity.status.toLowerCase() === 'active')
    );
  }

  /**
   * The identity of a wallet. A wallet the chain binds to a merged or
   * closing identity has none. The wallet's row in the index may be the
   * very row that identity is filed under (profileIdForSites in
   * profile-ids.ts files an imported identity under its legacy id, which
   * is that old row), but the mirror writes no rows for an identity that
   * isn't active, so the row is stale. Only a wallet the chain holds no
   * identity for is answered from the index (unmapped).
   */
  async byWallet(wallet: string): Promise<IdentityEntity | null> {
    const identity = await this.gateway.getIdentityByWallet(wallet);
    if (identity) {
      return this.isLive(identity)
        ? await this.toIdentityEntity(identity)
        : null;
    }
    return await this.unmapped(await this.rows.getIdentityByWallet(wallet));
  }

  async byHandle(handle: string): Promise<IdentityEntity | null> {
    const identity = await this.gateway.getIdentityByHandle(handle);
    if (this.isLive(identity)) return await this.toIdentityEntity(identity);
    if (!isPlaceholderHandle(handle)) return null;
    // A placeholder (`id-0x...`) is 6529.io's name for an identity without a
    // chain handle: find whose it is in the index, then read that identity:
    // the mapped one, else the one imported from that profile; a row the
    // chain holds no identity for (never imported) is answered as it is.
    const row = await this.rows.getIdentityByHandle(handle, {});
    if (!row?.profile_id) return row;
    const principal = await this.mapping.principalOfProfile(row.profile_id);
    const owner = principal
      ? await this.gateway.getIdentityByPrincipal(principal)
      : await this.importedFrom(row.profile_id);
    if (owner === undefined) return null;
    if (owner) {
      return this.isLive(owner) ? await this.toIdentityEntity(owner) : null;
    }
    return principal ? null : row;
  }

  async byProfileId(profileId: string): Promise<IdentityEntity | null> {
    const id = profileId.toLowerCase();
    const principal = await this.mapping.principalOfProfile(id);
    const identity = principal
      ? await this.gateway.getIdentityByPrincipal(principal)
      : await this.gateway.getIdentityByLegacyProfileId(id);
    // The chain's identity, if it holds one, live or not: a merged or
    // closing one has no rows the mirror writes, so the old row is stale.
    if (identity) {
      return this.isLive(identity)
        ? await this.toIdentityEntity(identity)
        : null;
    }
    return principal
      ? null
      : await this.unmapped(await this.rows.getIdentityByProfileId(id), true);
  }

  /**
   * A row the chain holds no identity for (never imported, nor mapped),
   * else nothing: an identity imported from the row's profile is the
   * chain's, reached through it, and the row is a stale one.
   * `importAsked`: the caller has asked the import for the row's profile.
   */
  private async unmapped(
    row: IdentityEntity | null,
    importAsked = false
  ): Promise<IdentityEntity | null> {
    if (!row) return null;
    if (!row.profile_id) return row;
    if (await this.mapping.principalOfProfile(row.profile_id)) return null;
    if (!importAsked && (await this.importedFrom(row.profile_id)) !== null) {
      return null;
    }
    return row;
  }

  /**
   * The identity the import made from a 6529.io profile, null when none;
   * undefined when the node that answered doesn't hold the import (another
   * may): the lookup then answers none rather than a row that may be stale.
   */
  private async importedFrom(
    profileId: string
  ): Promise<ChainIdentity | null | undefined> {
    try {
      return await this.gateway.getIdentityByLegacyProfileId(profileId);
    } catch (error) {
      if (isAnotherNodesToGive(error)) return undefined;
      throw error;
    }
  }

  /** The chain's answer on a handle: free to claim now, or why not. */
  async handleAvailability(
    handle: string
  ): Promise<{ available: boolean; message: string }> {
    const answer = await this.gateway.getHandle(handle);
    if (!answer || !answer.valid) {
      return {
        available: false,
        message: `Invalid username. Use 3-15 letters, numbers, or underscores.`
      };
    }
    return answer.available
      ? { available: true, message: 'Username is available.' }
      : {
          available: false,
          message: `This username is not available. Please choose a different one.`
        };
  }
}

export const chainIdentityReads = new ChainIdentityReads();
