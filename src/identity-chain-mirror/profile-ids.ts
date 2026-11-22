import { ChainGatewayClient } from '@/chain-gateway/chain-gateway.client';
import { ChainIdentity } from '@/chain-gateway/chain-gateway.types';
import { IdentityChainMirrorDb } from './identity-chain-mirror.db';
import { principalProfileId } from './identity-plan';
import { ChainReadRetryLater } from './mirror-errors';

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
>;

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
    const { profileId: chosen, origin } = await this.chooseProfileId(identity);
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
    return chosen;
  }

  private async chooseProfileId(
    identity: ChainIdentity
  ): Promise<{ profileId: string; origin: string }> {
    const principalId = identity.principalId.toLowerCase();
    const legacy = await this.legacyIdOf(identity);
    if (legacy) return { profileId: legacy, origin: 'LEGACY' };
    const wallet = await this.foundingWalletOf(identity);
    const placeholder = wallet
      ? await this.db.unmappedPlaceholderProfile(wallet)
      : null;
    if (
      wallet &&
      placeholder &&
      !(await this.gateway.getIdentityByLegacyProfileId(placeholder)) &&
      (await this.firstBoundTo(wallet, principalId, identity.createdHeight))
    ) {
      return { profileId: placeholder.toLowerCase(), origin: 'FOUNDER' };
    }
    return { profileId: principalProfileId(principalId), origin: 'NEW' };
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
   * from its creation. A binding seen before the creation says no.
   * Otherwise the history must cover every height from the import's start
   * to the creation without a gap; when it doesn't (a gateway node that
   * started later), the identity is not mapped now and is tried again next
   * run, rather than given a guess a rebuild might not repeat.
   */
  private async firstBoundTo(
    wallet: string,
    principal: string,
    createdHeight: number
  ): Promise<boolean> {
    const history = await this.gateway.getMembershipWalletHistory(wallet);
    // Bound to any identity before this one was made: not its first.
    const earlier = history?.changes.find(
      (it) => it.principalId !== null && Number(it.height) < createdHeight
    );
    if (earlier) return false;
    const start = this.importStart;
    if (
      !history ||
      start === null ||
      !covers(history.ranges, start, createdHeight)
    ) {
      throw new ChainReadRetryLater(
        `The history of ${wallet} doesn't reach back to the import: its identity is mapped later`,
        'history_short'
      );
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
