import { ChainGatewayClient } from '@/chain-gateway/chain-gateway.client';
import { ChainIdentity } from '@/chain-gateway/chain-gateway.types';
import { IdentityChainMirrorDb } from './identity-chain-mirror.db';
import { principalProfileId } from './identity-plan';
import { ChainReadRetryLater } from './mirror-errors';
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
  | 'firstBindingOf'
>;

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
   * The profile ids an identity whose id can't be settled yet could get:
   * its derived id and its founding wallet's placeholder. Its rows, if any,
   * are under one of them.
   */
  async candidateIds(identity: ChainIdentity): Promise<string[]> {
    const ids = [principalProfileId(identity.principalId.toLowerCase())];
    try {
      const wallet = await this.foundingWalletOf(identity);
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
    const legacy = await this.legacyIdOf(identity);
    if (!isInactive(identity)) {
      return {
        profileId: await this.profileIdOf(identity),
        imported: legacy !== null
      };
    }
    const principal = identity.principalId.toLowerCase();
    return {
      profileId:
        (await this.db.profileIdOfPrincipal(principal)) ??
        (await this.chooseProfileId(identity)).profileId,
      imported: legacy !== null
    };
  }

  /**
   * The 6529.io profile id of a chain identity: its mapping, else
   * - an imported identity's legacy id (its 6529.io profile id);
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
      left
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
    if (left) {
      logger.warn(
        `[FOUNDER PLACEHOLDER LEFT FOR A LATER MERGE] [${left}] [${principalId} MAPPED NEW: NEITHER THE MIRROR NOR THE GATEWAY CAN SAY IT WAS THE WALLET'S FIRST]`
      );
      this.left.push(left);
    }
    return chosen;
  }

  private async chooseProfileId(
    identity: ChainIdentity
  ): Promise<{ profileId: string; origin: string; left?: string }> {
    const principalId = identity.principalId.toLowerCase();
    const legacy = await this.legacyIdOf(identity);
    if (legacy) return { profileId: legacy, origin: 'LEGACY' };
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
      (await this.gateway.getIdentityByLegacyProfileId(placeholder))
    ) {
      return derived;
    }
    const first = await this.firstBoundTo(
      wallet,
      principalId,
      Number(identity.createdHeight)
    );
    if (first === 'unknowable') {
      return { ...derived, left: placeholder.toLowerCase() };
    }
    return first
      ? { profileId: placeholder.toLowerCase(), origin: 'FOUNDER' }
      : derived;
  }

  /**
   * The wallet that made the identity: the gateway's founder field; until
   * the gateway gives it, the anchor when it has been bound to the identity
   * since its creation; else none. Its placeholder goes to this identity
   * only when it is the first the wallet was ever bound to (firstBoundTo),
   * so that a wallet that made two identities gives it to the first
   * whatever order a rebuild reads them in.
   */
  private async foundingWalletOf(
    identity: ChainIdentity
  ): Promise<string | null> {
    if (identity.founder) return identity.founder.toLowerCase();
    if (!identity.anchor) return null;
    const binding = await this.gateway.getMembershipWallet(identity.anchor);
    const sinceCreation =
      binding?.principalId?.toLowerCase() ===
        identity.principalId.toLowerCase() &&
      Number(binding?.firstBoundHeight) === Number(identity.createdHeight);
    return sinceCreation ? identity.anchor.toLowerCase() : null;
  }

  /**
   * Whether `principal` is the first identity `wallet` was ever bound to,
   * from its creation:
   * - from the mirror's own first binding of the wallet, recorded while the
   *   wallet bindings followed the feed without a break from the import's
   *   start; while they haven't reached the creation yet, tried again later;
   * - else from the gateway's history of the wallet: a binding before the
   *   creation says no; otherwise it must cover every height from the
   *   import's start to the creation. A node behind is waited for (tried
   *   again later); a history that can never say (the import's start
   *   unknown, or the node's feed starting after it or with a gap) gives
   *   'unknowable'.
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
    const history = await this.gateway.getMembershipWalletHistory(wallet);
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
      const held = history.ranges.length
        ? history.ranges[history.ranges.length - 1][1]
        : start - 1;
      // Held from the import's start without a gap, only not that far yet.
      if (reach >= start && reach === held) {
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

  /**
   * The imported profile id. The import's entry is asked when the gateway
   * leaves the field out (older than the field), or gives none for an
   * identity created no later than the import's end, so an imported
   * identity is never taken for one made on the chain.
   */
  private async legacyIdOf(identity: ChainIdentity): Promise<string | null> {
    const given = identity.legacyId;
    const created = Number(identity.createdHeight);
    const madeAfterImport =
      this.importDone !== null && created > this.importDone;
    if (given || (given === null && madeAfterImport)) {
      return given?.toLowerCase() ?? null;
    }
    const entry = await this.gateway.getImportedIdentity(identity.principalId);
    return entry?.legacyId?.toLowerCase() ?? null;
  }
}
