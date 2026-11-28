import { ChainGatewayClient } from '@/chain-gateway/chain-gateway.client';
import { ChainIdentity } from '@/chain-gateway/chain-gateway.types';
import { IdentityChainMirrorDb } from './identity-chain-mirror.db';
import { consolidationKeyOf, principalProfileId } from './identity-plan';
import { ChainReadRetryLater, orRetryLater } from './mirror-errors';
import { Logger } from '@/logging';

const logger = Logger.get('IDENTITY_CHAIN_MIRROR');

type Gateway = Pick<
  ChainGatewayClient,
  | 'getMembershipWallet'
  | 'getMembershipWalletHistory'
  | 'getIdentityByLegacyProfileId'
  | 'getImportedIdentity'
>;

type Db = Pick<
  IdentityChainMirrorDb,
  | 'executeNativeQueriesInTransaction'
  | 'profileIdOfPrincipal'
  | 'insertMapping'
  | 'unmappedPlaceholderProfile'
  | 'handlelessRowsOf'
  | 'firstBindingOf'
  | 'founderWaitSince'
  | 'founderWaitDone'
  | 'founderDecisionOf'
  | 'founderDecided'
>;

/**
 * How long an identity whose founder no history can tell is tried again
 * before it is mapped to its derived id: the gateway may answer from
 * another node (one with the whole history) meanwhile.
 */
export const FOUNDER_WAIT_MS = 6 * 60 * 60 * 1000;

/**
 * The ids 6529.io issued handle-less rows before switch-on: randomUUID,
 * version 4 (the TDH sync's step B, a group listing an address). From
 * switch-on an address-only row's id is the address's derived one
 * (address-identity-id.ts), version 5.
 */
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_V5 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Whether a wallet was first bound to an identity at its creation. */
type FirstBound = boolean | 'unknowable';

/**
 * The last height h such that the ranges cover every height from `from` to
 * h without a gap (from - 1 when they don't hold `from`).
 */
export function coveredTo(
  ranges: readonly [number, number][],
  from: number
): number {
  let next = from;
  for (const [start, end] of ranges) {
    if (start > next) break;
    next = Math.max(next, end + 1);
  }
  return next - 1;
}

/**
 * Whether height ranges (`[from, to]`, ascending) cover every height from
 * `from` to `to` without a gap.
 */
export function covers(
  ranges: readonly [number, number][],
  from: number,
  to: number
): boolean {
  let next = from;
  for (const [start, end] of ranges) {
    if (start > next) break;
    next = Math.max(next, end + 1);
    if (next > to) return true;
  }
  return next > to;
}

/** Merged, closing or walletless: nothing of it is written. */
export function isInactive(identity: ChainIdentity): boolean {
  return (
    !!identity.mergedInto ||
    !identity.wallets.length ||
    (!!identity.status && identity.status.toLowerCase() !== 'active')
  );
}

/**
 * The 6529.io profile ids of chain identities, chosen from the chain alone
 * so a rebuild gives the same ids, and kept in identity_chain_principals.
 */
export class ProfileIds {
  private importStart: number | null = null;
  private importDone: number | null = null;
  /** Placeholders left to a later merge since last taken (see below). */
  private left: string[] = [];
  /** Handle-less rows' keys not adopted since last taken (see below). */
  private notAdopted: string[] = [];

  constructor(
    private readonly gateway: Gateway,
    private readonly db: Db,
    private readonly now: () => number
  ) {}

  /** The import's heights, as a mirror run read them. */
  setImportHeights(start: number | null, done: number | null) {
    this.importStart = start;
    this.importDone = done;
  }

  /**
   * The founders' placeholder profiles left without their identity since
   * the last call, because neither the mirror nor the gateway can say
   * whether the identity was the wallet's first: for the later merge.
   */
  takeLeftPlaceholders(): string[] {
    const left = this.left;
    this.left = [];
    return left;
  }

  /**
   * The keys of handle-less rows holding some of an identity's wallets
   * that the identity didn't take, since the last call: their ids stay on
   * rows the identity's write then re-keys or leaves without wallets.
   */
  takeNotAdopted(): string[] {
    const keys = this.notAdopted;
    this.notAdopted = [];
    return keys;
  }

  /**
   * The profile ids an identity whose id can't be settled yet could get:
   * its legacy id, its derived id and its founding wallet's placeholder.
   * Its rows, if any, are under one of them.
   */
  async candidateIds(identity: ChainIdentity): Promise<string[]> {
    const ids = [principalProfileId(identity.principalId.toLowerCase())];
    try {
      const choice = this.choice();
      const legacy = await choice.legacyIdOf(identity);
      if (legacy) ids.push(legacy);
      const adopted = await choice.adoptedProfileId(identity);
      if (adopted) ids.push(adopted);
      const wallet = await choice.foundingWalletOf(identity);
      const placeholder = wallet
        ? await this.db.unmappedPlaceholderProfile(wallet)
        : null;
      if (placeholder) ids.push(placeholder.toLowerCase());
    } catch {
      // The derived id alone.
    }
    return ids;
  }

  /**
   * The profile id the profile site index files an identity under, and
   * whether the import made it: the mirror's own id (mapped now if needed)
   * for an identity the mirror writes; for a merged or closed one, its
   * mapping if it has one, else the id the same rule gives (legacy id,
   * founding wallet's placeholder, derived id), with nothing stored, so a
   * rebuild from the chain files it the same way.
   */
  async profileIdForSites(
    identity: ChainIdentity
  ): Promise<{ profileId: string; imported: boolean }> {
    const legacy = await this.choice().legacyIdOf(identity);
    if (!isInactive(identity)) {
      return {
        profileId: await this.profileIdOf(identity),
        imported: legacy !== null
      };
    }
    const principal = identity.principalId.toLowerCase();
    const mapped =
      (await this.db.profileIdOfPrincipal(principal)) ??
      (await this.db.founderDecisionOf(principal));
    if (mapped) return { profileId: mapped, imported: legacy !== null };
    // Not noted here: a merged or closed identity is asked for each time.
    const chosen = await this.chooseProfileId(identity, false);
    // Decided from its founder: kept, so it is filed under this id only.
    if (chosen.founderAsked) {
      await this.db.founderDecided(principal, chosen.profileId, this.now());
    }
    return { profileId: chosen.profileId, imported: legacy !== null };
  }

  /**
   * The 6529.io profile id of a chain identity: its mapping, else
   * - an imported identity's legacy id (its 6529.io profile id);
   * - else the id of the handle-less row under the identity's own
   *   consolidation key (no handle, no profiles row, no principal): 6529.io
   *   issued it before switch-on and ratings, follows and groups may name it;
   * - for an identity made on the chain, the listed placeholder profile of
   *   the wallet that made it, when no principal holds it, the import didn't
   *   take it, and this is the first identity that wallet was bound to, so
   *   the wallet's follows and history stay with it;
   * - else the principal id's first 16 bytes written as a UUID.
   * The placeholders are listed before the mirror's first write and 6529.io
   * makes none from switch-on, so a rebuild from the chain gives the same
   * ids.
   */
  async profileIdOf(identity: ChainIdentity): Promise<string> {
    const principalId = identity.principalId.toLowerCase();
    const mapped = await this.db.profileIdOfPrincipal(principalId);
    if (mapped) return mapped;
    const {
      profileId: chosen,
      origin,
      left,
      founderAsked
    } = await this.chooseProfileId(identity);
    try {
      await this.db.executeNativeQueriesInTransaction((conn) =>
        this.db.insertMapping(principalId, chosen, origin, this.now(), conn)
      );
    } catch (error) {
      // Another run mapped it meanwhile: use that.
      const again = await this.db.profileIdOfPrincipal(principalId);
      if (again) return again;
      throw error;
    }
    // Stored: a wait for its founder is over. (Not stored, as for a merged
    // identity, the wait stays, so later calls give the derived id at once.)
    if (founderAsked) await this.db.founderWaitDone(principalId);
    if (left) {
      logger.warn(
        `[FOUNDER PLACEHOLDER LEFT FOR A LATER MERGE] [${left}] [${principalId} MAPPED NEW: NEITHER THE MIRROR NOR THE GATEWAY CAN SAY IT WAS THE WALLET'S FIRST]`
      );
      this.left.push(left);
    }
    return chosen;
  }

  /**
   * The choice, with the import's heights as this run read them. `note`:
   * the handle-less rows it doesn't take are logged (WARN, with their keys)
   * and counted for the run (takeNotAdopted).
   */
  private choice(note = false): MirrorProfileIdChoice {
    return new MirrorProfileIdChoice(
      this.gateway,
      this.db,
      this.importStart,
      this.importDone,
      note
        ? (keys, warning) => {
            logger.warn(warning);
            this.notAdopted.push(...keys);
          }
        : undefined
    );
  }

  /**
   * The choice, and when no history can tell whether the identity was its
   * founding wallet's first: tried again for a while (the founder wait),
   * then the derived id, the placeholder left for a later merge. `note`:
   * as for choice().
   */
  private async chooseProfileId(
    identity: ChainIdentity,
    note = true
  ): Promise<{
    profileId: string;
    origin: string;
    left?: string;
    founderAsked?: boolean;
  }> {
    const chosen = await this.choice(note).choose(identity);
    if (!('unknowable' in chosen)) return chosen;
    const principalId = identity.principalId.toLowerCase();
    const { wallet, placeholder } = chosen;
    // One node's answer decides nothing: tried again for a while, and
    // mapped to the derived id only when it stays so.
    const since = await this.db.founderWaitSince(principalId, this.now());
    if (this.now() - since < FOUNDER_WAIT_MS) {
      throw new ChainReadRetryLater(
        `No history tells whether ${wallet} was first bound to ${principalId} yet: tried again until ${new Date(since + FOUNDER_WAIT_MS).toISOString()}`,
        'founder_unknown_yet'
      );
    }
    return {
      profileId: principalProfileId(principalId),
      origin: 'NEW',
      left: placeholder,
      founderAsked: true
    };
  }
}

/** The mirror's tables the choice of a profile id reads: it writes none. */
export type ProfileIdChoiceDb = Pick<
  IdentityChainMirrorDb,
  'unmappedPlaceholderProfile' | 'handlelessRowsOf' | 'firstBindingOf'
>;

/**
 * Handle-less rows holding some of an identity's wallets that it didn't
 * take (their keys), with the WARN line naming them: the mirror's run logs
 * and counts them; a read notes nothing.
 */
type NotAdoptedNote = (keys: string[], warning: string) => void;

/**
 * The gateway reads of a choice from the mirror's own state: what the chain
 * says the same on every node (the import's entries, its legacy ids).
 */
export type ProfileIdChoiceGateway = Pick<
  ChainGatewayClient,
  'getIdentityByLegacyProfileId' | 'getImportedIdentity'
>;

/**
 * How the mirror chooses a chain identity's profile id (see
 * ProfileIds.profileIdOf), from the chain and the mirror's tables, which it
 * only reads (its table type has no write). This class is a read's, for an
 * identity the mirror hasn't mapped: what the mirror's own state can't
 * decide it leaves undecided (ChainReadRetryLater; readOnlyProfileId throws
 * a gateway answer another node may give as the gateway's error), and its
 * gateway type
 * has no read one node could answer otherwise than the node the mirror's
 * runs get (a wallet's history, the anchor's binding now).
 * MirrorProfileIdChoice, the mirror's own, decides those from the gateway.
 */
export class ProfileIdChoice {
  constructor(
    private readonly gateway: ProfileIdChoiceGateway,
    private readonly db: ProfileIdChoiceDb,
    private readonly importDone: number | null,
    private readonly noteNotAdopted?: NotAdoptedNote
  ) {}

  /**
   * The profile id for an identity with no mapping: its legacy id; else
   * the id of the handle-less row under its own consolidation key
   * (adoptedProfileId); else its founding wallet's unmapped placeholder
   * (not taken by the import) when this is that wallet's first identity;
   * else the derived id. When no history can tell whether it was the
   * first: `unknowable`, for the caller's founder wait. Throws
   * ChainReadRetryLater while it can't be told yet.
   */
  async choose(identity: ChainIdentity): Promise<
    | {
        profileId: string;
        origin: string;
        founderAsked?: boolean;
      }
    | { unknowable: true; wallet: string; placeholder: string }
  > {
    const principalId = identity.principalId.toLowerCase();
    const legacy = await this.legacyIdOf(identity);
    if (legacy) return { profileId: legacy, origin: 'LEGACY' };
    const adopted = await this.adoptedProfileId(identity);
    if (adopted) return { profileId: adopted, origin: 'ADOPTED' };
    const wallet = await this.foundingWalletOf(identity);
    const placeholder = wallet
      ? await this.db.unmappedPlaceholderProfile(wallet)
      : null;
    const derived = {
      profileId: principalProfileId(principalId),
      origin: 'NEW'
    };
    if (
      !wallet ||
      !placeholder ||
      (await orRetryLater(() =>
        this.gateway.getIdentityByLegacyProfileId(placeholder)
      ))
    ) {
      return derived;
    }
    const first = await this.firstBoundTo(
      wallet,
      principalId,
      Number(identity.createdHeight)
    );
    if (first === 'unknowable') {
      return {
        unknowable: true,
        wallet,
        placeholder: placeholder.toLowerCase()
      };
    }
    return first
      ? {
          profileId: placeholder.toLowerCase(),
          origin: 'FOUNDER',
          founderAsked: true
        }
      : { ...derived, founderAsked: true };
  }

  /**
   * The id of the handle-less identities row whose consolidation key
   * equals the identity's (its wallets, keyed as 6529.io keys them): a row
   * with a profile id but no handle, no profiles row and no principal,
   * which 6529.io made before switch-on (the TDH sync's step B, a group
   * listing an address). Its id may already be named by ratings, follows
   * and groups, so the identity keeps it rather than a new one. Only an
   * equal key: a handle-less row holding some of the identity's wallets
   * under another key is a different group of wallets, so it isn't taken;
   * it is noted (noteNotAdopted: the mirror's run logs it, WARN with the
   * key, and counts it). Only an id issued before switch-on (randomUUID,
   * version 4): a row made after it has its address's derived id (version
   * 5), which a rebuild doesn't make until after the identities (the waves
   * rebuild runs after them), so taking it would give the identity another
   * id there; such a row is left to the plan, which orphans it. An id of
   * neither version is not guessed at: noted (WARN) and not taken.
   */
  async adoptedProfileId(identity: ChainIdentity): Promise<string | null> {
    if (!identity.wallets.length) return null;
    const key = consolidationKeyOf(identity.wallets);
    const rows = await this.db.handlelessRowsOf(identity.wallets, key);
    const equal = rows.find((it) => it.consolidation_key.toLowerCase() === key);
    if (equal) {
      const id = equal.profile_id.toLowerCase();
      if (UUID_V4.test(id)) return id;
      if (!UUID_V5.test(id)) {
        this.noteNotAdopted?.(
          [key],
          `[HANDLE-LESS ROW NOT ADOPTED: ID NEITHER V4 NOR V5] [${identity.principalId.toLowerCase()}] [KEY ${key}] [ID ${id}]`
        );
      }
      return null;
    }
    if (rows.length) {
      const keys = rows.map((it) => it.consolidation_key.toLowerCase());
      this.noteNotAdopted?.(
        keys,
        `[HANDLE-LESS ROWS NOT ADOPTED] [${identity.principalId.toLowerCase()}] [KEY ${key}] [ROWS ${keys.join(', ')}] [NO EQUAL KEY: THE DERIVED OR FOUNDER'S ID]`
      );
    }
    return null;
  }

  /**
   * The wallet that made the identity: the gateway's founder field; without
   * it, foundingWalletWithoutFounder (here undecided; the mirror's own
   * choice takes the anchor). Its placeholder goes to this identity only
   * when it is the first the wallet was ever bound to (firstBoundTo), so
   * that a wallet that made two identities gives it to the first whatever
   * order a rebuild reads them in.
   */
  async foundingWalletOf(identity: ChainIdentity): Promise<string | null> {
    if (identity.founder) return identity.founder.toLowerCase();
    return await this.foundingWalletWithoutFounder(identity);
  }

  /**
   * No founder from the gateway: the anchor's binding now would decide,
   * which a read can't take for what the mirror's runs will see.
   */
  protected async foundingWalletWithoutFounder(
    identity: ChainIdentity
  ): Promise<string | null> {
    throw new ChainReadRetryLater(
      `No founder of ${identity.principalId} from the gateway`,
      'founder_not_given'
    );
  }

  /**
   * Whether `principal` is the first identity `wallet` was ever bound to,
   * from its creation, from the mirror's own first binding of the wallet,
   * recorded while the wallet bindings followed the feed without a break
   * from the import's start (while they haven't reached the creation yet,
   * tried again later); else from firstBoundFromHistory.
   */
  private async firstBoundTo(
    wallet: string,
    principal: string,
    createdHeight: number
  ): Promise<FirstBound> {
    const own = await this.db.firstBindingOf(wallet);
    if (own.first) {
      return (
        own.first.principal_id === principal &&
        own.first.height === createdHeight
      );
    }
    if (own.exact) {
      // A founder is bound at the creation: past it, there'd be a record.
      if (own.nextHeight !== null && own.nextHeight > createdHeight) {
        return false;
      }
      throw new ChainReadRetryLater(
        `The wallet bindings haven't reached ${createdHeight} yet: the identity is mapped later`,
        'bindings_behind'
      );
    }
    return await this.firstBoundFromHistory(wallet, principal, createdHeight);
  }

  /**
   * The mirror's own bindings can't tell: a read leaves it undecided. One
   * node's history could say what another's, which the mirror's runs may
   * get, can't.
   */
  protected async firstBoundFromHistory(
    wallet: string,
    principal: string,
    _createdHeight: number
  ): Promise<FirstBound> {
    throw new ChainReadRetryLater(
      `The mirror's own bindings can't tell whether ${wallet} was first bound to ${principal}`,
      'bindings_cant_tell'
    );
  }

  /**
   * The imported profile id. The import's entry is asked when the gateway
   * leaves the field out (older than the field), or gives none for an
   * identity created no later than the import's end, so an imported
   * identity is never taken for one made on the chain.
   */
  async legacyIdOf(identity: ChainIdentity): Promise<string | null> {
    const given = identity.legacyId;
    const created = Number(identity.createdHeight);
    const madeAfterImport =
      this.importDone !== null && created > this.importDone;
    if (given || (given === null && madeAfterImport)) {
      return given?.toLowerCase() ?? null;
    }
    const entry = await orRetryLater(() =>
      this.gateway.getImportedIdentity(identity.principalId)
    );
    return entry?.legacyId?.toLowerCase() ?? null;
  }

  /**
   * The profile id the mirror will store for an identity it hasn't mapped,
   * or null while that can't be told from its own state. A gateway answer
   * another node may give (not_held, bad_answer) is thrown as the gateway's
   * error: the gateway didn't answer, which the caller handles (the identity
   * reads answer from the mirror's tables), never a guess at the id.
   */
  async readOnlyProfileId(identity: ChainIdentity): Promise<string | null> {
    try {
      const chosen = await this.choose(identity);
      return 'unknowable' in chosen ? null : chosen.profileId;
    } catch (error) {
      if (error instanceof ChainReadRetryLater) {
        if (error.gatewayError) throw error.gatewayError;
        return null;
      }
      throw error;
    }
  }
}

/**
 * The mirror's own choice: as ProfileIdChoice, and what its own state can't
 * decide, from the gateway (FOUNDER_WAIT_MS bounds the cases no node can).
 */
export class MirrorProfileIdChoice extends ProfileIdChoice {
  constructor(
    private readonly mirrorGateway: Gateway,
    db: ProfileIdChoiceDb,
    private readonly importStart: number | null,
    importDone: number | null,
    noteNotAdopted?: NotAdoptedNote
  ) {
    super(mirrorGateway, db, importDone, noteNotAdopted);
  }

  /**
   * Until the gateway gives the founder, the anchor when it has been bound
   * to the identity since its creation; else none.
   */
  protected override async foundingWalletWithoutFounder(
    identity: ChainIdentity
  ): Promise<string | null> {
    if (!identity.anchor) return null;
    const anchor = identity.anchor;
    const binding = await orRetryLater(() =>
      this.mirrorGateway.getMembershipWallet(anchor)
    );
    const sinceCreation =
      binding?.principalId?.toLowerCase() ===
        identity.principalId.toLowerCase() &&
      Number(binding?.firstBoundHeight) === Number(identity.createdHeight);
    return sinceCreation ? identity.anchor.toLowerCase() : null;
  }

  /**
   * From the gateway's history of the wallet: a binding before the
   * creation says no; otherwise it must cover every height from the
   * import's start to the creation. A node behind is waited for (tried
   * again later); a history that can't say (the import's start unknown, or
   * the node's feed starting after it or with a gap) gives 'unknowable',
   * which the mirror waits on for FOUNDER_WAIT_MS before deciding.
   */
  protected override async firstBoundFromHistory(
    wallet: string,
    principal: string,
    createdHeight: number
  ): Promise<FirstBound> {
    const history = await orRetryLater(() =>
      this.mirrorGateway.getMembershipWalletHistory(wallet, {
        noBindingsBefore: this.importStart
      })
    );
    if (!history) {
      throw new ChainReadRetryLater(
        `No history of ${wallet} yet: the identity is mapped later`,
        'history_missing'
      );
    }
    // Bound to any identity before this one was made: not its first.
    const earlier = history.changes.find(
      (it) => it.principalId !== null && Number(it.height) < createdHeight
    );
    if (earlier) return false;
    const start = this.importStart;
    if (start === null) return 'unknowable';
    const reach = coveredTo(history.ranges, start);
    if (reach < createdHeight) {
      // Held from the import's start without a gap, only not that far yet:
      // the node's history ends with its read (the client keeps a history's
      // first range only, up to the read). A range that ends before a read
      // past the creation is a gap: it can't say.
      if (reach >= start && history.readHeight < createdHeight) {
        throw new ChainReadRetryLater(
          `The history of ${wallet} doesn't reach ${createdHeight} yet: the identity is mapped later`,
          'history_behind'
        );
      }
      return 'unknowable';
    }
    const first = history.changes.find((it) => it.principalId !== null);
    return (
      first?.principalId === principal &&
      Number(first.height) === Number(createdHeight)
    );
  }
}
