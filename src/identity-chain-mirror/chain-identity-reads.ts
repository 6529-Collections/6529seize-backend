import {
  ChainGatewayClient,
  ChainGatewayError,
  chainGatewayHeadTtlMs,
  identityReadsGatewayClient
} from '@/chain-gateway/chain-gateway.client';
import { ChainIdentity } from '@/chain-gateway/chain-gateway.types';
import { appFeatures } from '@/app-features';
import { IdentityEntity } from '@/entities/IIdentity';
import { ProfileClassification } from '@/entities/IProfile';
import { enums } from '@/enums';
import { CustomApiCompliantException } from '@/exceptions';
import { identitiesDb, IdentitiesDb } from '@/identities/identities.db';
import { loggerContext } from '@/logger-context';
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
import {
  identityReadsShadow,
  IdentityReadsShadow
} from './identity-reads-shadow';
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
  | 'lastSeenNetwork'
>;

/**
 * The identity mirror's tables the reads ask: which chain they are of, and
 * what its choice of a profile id reads. No write is in the type, so a read
 * can't write the mirror's tables.
 */
type MirrorDb = ProfileIdChoiceDb &
  Pick<IdentityChainMirrorDb, 'mirrorChainState'>;

type MirrorChainState = Awaited<ReturnType<MirrorDb['mirrorChainState']>>;

/**
 * How recently the mirror must have saved its state for a lookup to be
 * answered from its tables while the gateway can't answer.
 */
export const MIRROR_FRESH_MS = 5 * 60 * 1000;

/** At most one WARN line a minute per lookup kind and outcome. */
const WARN_EVERY_MS = 60_000;

const UNAVAILABLE_CODES = new Set([
  'network',
  'timeout',
  'not_held',
  'height_gone',
  'bad_answer',
  'wrong_network'
]);
const UNAVAILABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

/**
 * A gateway failure a lookup may answer around (from the mirror's tables,
 * or a 503): the gateway or its node couldn't answer now. Anything else (a
 * refusal of the request, a setting missing) propagates.
 */
export function isGatewayUnavailable(
  error: unknown
): error is ChainGatewayError {
  return (
    error instanceof ChainGatewayError &&
    (UNAVAILABLE_CODES.has(error.code) ||
      (error.status !== null && UNAVAILABLE_STATUSES.has(error.status)))
  );
}

/** The 503 a lookup answers when neither the chain nor the mirror can. */
function identitiesUnavailable(message: string): CustomApiCompliantException {
  return new CustomApiCompliantException(
    503,
    message,
    'IDENTITY_READS_UNAVAILABLE'
  );
}

type FallbackKind = 'by_wallet' | 'by_handle' | 'by_profile_id';

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
 * imported) is answered from those tables as before. While the gateway
 * can't answer, a lookup is answered from those tables too, as with the
 * flag off, if the mirror is fresh (orMirror); handle availability then
 * answers 503. The reads use their own gateway client
 * (identityReadsGatewayClient: CHAIN_GATEWAY_IDENTITY_RETRIES and
 * CHAIN_GATEWAY_IDENTITY_TIMEOUT_MS).
 */
export class ChainIdentityReads {
  /**
   * The height the import ended at, by network, once it completed there
   * (it doesn't change then; a relaunch is another network).
   */
  private readonly importsDone = new Map<string, { done: number | null }>();
  /** The mirror's state, kept for the gateway's head time. */
  private mirrorState: {
    at: number;
    value: Promise<MirrorChainState>;
  } | null = null;
  /** The WARN lines' last time and the events since, by kind and outcome. */
  private readonly warned = new Map<string, { at: number; count: number }>();

  constructor(
    private readonly gateway: Gateway = identityReadsGatewayClient,
    private readonly mapping: MappingDb = identityChainMirrorDb,
    private readonly rows: RowsDb = identitiesDb,
    private readonly mirror: MirrorDb = identityChainMirrorDb,
    private readonly options: {
      readonly now?: () => number;
      readonly headTtlMs?: () => number;
      readonly shadow?: IdentityReadsShadow;
    } = {}
  ) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private get shadow(): IdentityReadsShadow {
    return this.options.shadow ?? identityReadsShadow;
  }

  /**
   * The mirror's state row (its chain, its placeholders' listing, its last
   * save), read at most once per gateway head time
   * (CHAIN_GATEWAY_HEAD_TTL_MS) on this instance, not once per lookup; a
   * failed read isn't kept.
   */
  private async mirrorChainState(): Promise<MirrorChainState> {
    const now = this.now();
    const ttl = (this.options.headTtlMs ?? chainGatewayHeadTtlMs)();
    if (!this.mirrorState || now - this.mirrorState.at >= ttl) {
      const value = this.mirror.mirrorChainState();
      const kept = { at: now, value };
      this.mirrorState = kept;
      value.catch(() => {
        if (this.mirrorState === kept) this.mirrorState = null;
      });
    }
    return await this.mirrorState.value;
  }

  /**
   * The 6529.io profile id the identity's rows use: its mapping, else the
   * id the identity mirror will store for it, chosen as the mirror chooses
   * (ProfileIdChoice, read only: legacy id, the handle-less row's id under
   * its own consolidation key, the founding wallet's placeholder when the
   * mirror's own bindings say it is that wallet's first identity, else the
   * derived id). Null while the mirror's tables
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
      this.mirrorChainState(),
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

  /**
   * The identity's profile document. When the gateway can't answer
   * (isGatewayUnavailable) the error goes to the lookup, which answers from
   * the mirror's tables (orMirror), never an identity without its
   * document. A document that can't be read (bytes that don't decode, a
   * CID that doesn't match) is left out: the identity without it, and a
   * WARN at most once a minute.
   */
  private async docOf(
    identity: ChainIdentity
  ): Promise<ProfileDocFields | null> {
    const cid = identity.profile?.docCid;
    if (!cid) return null;
    try {
      const bytes = await this.gateway.getProfileDoc(cid);
      return bytes ? toProfileDocFields(decodeProfileDoc(bytes)) : null;
    } catch (error) {
      if (isGatewayUnavailable(error)) throw error;
      const message = (error as Error)?.message ?? String(error);
      this.warnAtMostEveryMinute(
        'profile doc',
        (count) =>
          `[PROFILE DOC ${cid} OF ${identity.principalId} UNREADABLE] [${message}] [${count} SINCE THE LAST LINE]`
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
   * identity for is answered from the index (unmapped). While the gateway
   * can't answer: orMirror.
   */
  async byWallet(wallet: string): Promise<IdentityEntity | null> {
    return await this.orMirror(
      'by_wallet',
      () => this.chainByWallet(wallet),
      () => this.rows.getIdentityByWallet(wallet)
    );
  }

  /** The identity of a handle (see byWallet for the gateway failing). */
  async byHandle(handle: string): Promise<IdentityEntity | null> {
    return await this.orMirror(
      'by_handle',
      () => this.chainByHandle(handle),
      () => this.rows.getIdentityByHandle(handle, {})
    );
  }

  /** The identity of a profile id (see byWallet for the gateway failing). */
  async byProfileId(profileId: string): Promise<IdentityEntity | null> {
    return await this.orMirror(
      'by_profile_id',
      () => this.chainByProfileId(profileId),
      () => this.rows.getIdentityByProfileId(profileId.toLowerCase())
    );
  }

  /**
   * A lookup from the chain; when the gateway can't answer
   * (isGatewayUnavailable), from 6529.io's identities table instead: the
   * rows the lookup reads with the flag off, which the identity mirror keeps
   * from the chain, about a minute behind. Such a response carries
   * `X-6529-Identity-Source: mirror` (identitySourceHeaderMiddleware). Only
   * while the mirror is fresh (mirrorStaleness); otherwise a 503. Either
   * way a WARN line (at most one a minute per kind and outcome, with the
   * count since the last) and the shadow line's counts.
   */
  private async orMirror(
    kind: FallbackKind,
    fromChain: () => Promise<IdentityEntity | null>,
    fromMirror: () => Promise<IdentityEntity | null>
  ): Promise<IdentityEntity | null> {
    try {
      return await fromChain();
    } catch (error) {
      if (!isGatewayUnavailable(error)) throw error;
      const stale = await this.mirrorStaleness();
      if (stale !== null) {
        this.shadow.mirror503();
        this.warn('503', kind, error, stale);
        throw identitiesUnavailable(
          "Identities can't be read right now. Try again in a minute."
        );
      }
      const answer = await fromMirror();
      loggerContext.setIdentitySource('mirror');
      this.shadow.mirrorFallback();
      this.warn('mirror', kind, error, null);
      return answer;
    }
  }

  /**
   * Why the mirror's tables can't stand in for the chain now, or null when
   * they can: the mirror saved its state within MIRROR_FRESH_MS of now, and
   * its tables are of the network this instance's gateway client last read
   * (not compared before the client has read a head).
   */
  private async mirrorStaleness(): Promise<string | null> {
    const state = await this.mirrorChainState();
    if (state?.updatedAt === null || state?.updatedAt === undefined) {
      return 'NO MIRROR STATE';
    }
    const age = this.now() - state.updatedAt;
    if (Math.abs(age) > MIRROR_FRESH_MS) {
      return `MIRROR SAVED ${Math.round(age / 1000)} S AGO`;
    }
    const seen = this.gateway.lastSeenNetwork();
    if (seen !== null && state.chainId?.toLowerCase() !== seen.toLowerCase()) {
      return `MIRROR OF ${state.chainId}, GATEWAY ON ${seen}`;
    }
    return null;
  }

  private warn(
    outcome: 'mirror' | '503',
    kind: FallbackKind | 'availability',
    error: ChainGatewayError,
    why: string | null
  ) {
    const what =
      outcome === 'mirror' ? 'ANSWERED FROM THE MIRROR' : 'ANSWERED 503';
    const status = error.status === null ? '' : ` ${error.status}`;
    this.warnAtMostEveryMinute(
      `${outcome} ${kind}`,
      (count) =>
        `[IDENTITY LOOKUP ${what}] [${kind}] [GATEWAY ${error.code}${status}]${why ? ` [${why}]` : ''} [${count} SINCE THE LAST LINE]`
    );
  }

  /**
   * A WARN line at most once a minute on this instance for `key`, with the
   * count of events since the last line (this one included).
   */
  private warnAtMostEveryMinute(key: string, line: (count: number) => string) {
    const now = this.now();
    const entry = this.warned.get(key) ?? {
      at: Number.NEGATIVE_INFINITY,
      count: 0
    };
    entry.count++;
    this.warned.set(key, entry);
    if (now - entry.at < WARN_EVERY_MS) return;
    logger.warn(line(entry.count));
    entry.at = now;
    entry.count = 0;
  }

  private async chainByWallet(wallet: string): Promise<IdentityEntity | null> {
    const identity = await this.gateway.getIdentityByWallet(wallet);
    if (identity) {
      return this.isLive(identity)
        ? await this.toIdentityEntity(identity)
        : null;
    }
    return await this.unmapped(await this.rows.getIdentityByWallet(wallet));
  }

  private async chainByHandle(handle: string): Promise<IdentityEntity | null> {
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
      : await this.gateway.getIdentityByLegacyProfileId(row.profile_id);
    if (owner) {
      return this.isLive(owner) ? await this.toIdentityEntity(owner) : null;
    }
    return principal ? null : row;
  }

  private async chainByProfileId(
    profileId: string
  ): Promise<IdentityEntity | null> {
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
   * A node that can't say whether the import took the profile (not_held,
   * bad_answer) fails the lookup like any gateway failure: orMirror.
   */
  private async unmapped(
    row: IdentityEntity | null,
    importAsked = false
  ): Promise<IdentityEntity | null> {
    if (!row) return null;
    if (!row.profile_id) return row;
    if (await this.mapping.principalOfProfile(row.profile_id)) return null;
    if (
      !importAsked &&
      (await this.gateway.getIdentityByLegacyProfileId(row.profile_id)) !== null
    ) {
      return null;
    }
    return row;
  }

  /**
   * The chain's answer on a handle: free to claim now, or why not. Never
   * from the mirror: while the gateway can't answer (isGatewayUnavailable),
   * a 503.
   */
  async handleAvailability(
    handle: string
  ): Promise<{ available: boolean; message: string }> {
    let answer: Awaited<ReturnType<Gateway['getHandle']>>;
    try {
      answer = await this.gateway.getHandle(handle);
    } catch (error) {
      if (!isGatewayUnavailable(error)) throw error;
      this.shadow.mirror503();
      this.warn('503', 'availability', error, null);
      throw identitiesUnavailable(
        "Handles can't be checked right now. Try again in a minute."
      );
    }
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
