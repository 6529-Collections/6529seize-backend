import { identitiesDb } from '@/identities/identities.db';
import { isWalletAddress } from '@/signed-records/record-families';
import type { PrincipalBindingSource } from '@/signed-records/record-verify';

/**
 * The chain's identities, as the shared gateway client reads them
 * (`ChainGatewayClient`: these are its method names and fields).
 * wireSignedRecordsChainAtStartup wires the client in, through
 * signedRecordsChainOf (record-chain.ts), with the anchor service's source.
 */
export interface ChainIdentityReader {
  /**
   * Every binding change of a wallet the gateway's feed holds
   * (GET /v1/membership/wallets/{a}/history). Its principal at height H
   * is the last change at or below H, exact for any H within `ranges`.
   * A pinned read (`?height=`) reaches back only minutes, so a record's
   * anchor and a rebuild read bindings here.
   */
  getMembershipWalletHistory(
    wallet: string
  ): Promise<ChainWalletHistoryLike | null>;
  /** The identity of a wallet; pinned to `height` when given. */
  getIdentityByWallet(
    wallet: string,
    opts?: { readonly height?: number }
  ): Promise<ChainIdentityLike | null>;
  getIdentityByPrincipal(
    principalId: string,
    opts?: { readonly height?: number }
  ): Promise<ChainIdentityLike | null>;
  /** Wallet to identity (null: unbound), at one height; batched by the client. */
  getIdentitiesByWallets?(
    wallets: string[],
    opts?: { readonly height?: number }
  ): Promise<Record<string, ChainIdentityLike | null>>;
}

export interface ChainWalletHistoryLike {
  // Ascending.
  readonly changes: readonly {
    readonly height: number;
    readonly principalId: string | null;
  }[];
  // [from, to], inclusive: the heights the history is exact within.
  readonly ranges: readonly (readonly [number, number])[];
  // The finalized height of the read.
  readonly readHeight: number;
}

export interface ChainIdentityLike {
  readonly principalId: string;
  // BoundAt order.
  readonly wallets: readonly string[];
  // The 6529.io profile id it was imported from, when known.
  readonly legacyId?: string | null;
}

export interface ProfileIdsByWallet {
  getProfileIdByWallet(wallet: string): Promise<string | null>;
}

/**
 * Maps record owners to 6529.io profiles. A record's owner (and the target
 * of a follow, mute, block, alert or alias member) is a principal id, or a
 * bare wallet bound to no principal.
 */
export interface RecordOwnerDirectory extends PrincipalBindingSource {
  /** The owner a wallet writes as at this height: its principal, or itself when unbound. */
  ownerAt(wallet: string, height: number): Promise<string>;
  /** The 6529.io profile of an owner, or null when it has none. */
  profileIdOf(owner: string): Promise<string | null>;
}

const CACHE_LIMIT = 2_000;

class SmallCache<V> {
  private readonly map = new Map<string, V>();

  get(key: string): V | undefined {
    return this.map.get(key);
  }

  set(key: string, value: V): void {
    if (this.map.size >= CACHE_LIMIT) {
      this.map.clear();
    }
    this.map.set(key, value);
  }

  clear(): void {
    this.map.clear();
  }
}

export class ChainRecordOwnerDirectory implements RecordOwnerDirectory {
  private chain: ChainIdentityReader | null = null;
  // A binding at a finalized height never changes.
  private readonly bindings = new SmallCache<string | null>();

  constructor(private readonly profiles: ProfileIdsByWallet) {}

  /** Wires the gateway client in. Without it every wallet is unbound. */
  setChain(chain: ChainIdentityReader | null): void {
    this.chain = chain;
    this.bindings.clear();
  }

  /** Whether the gateway client is wired in. */
  hasChain(): boolean {
    return this.chain !== null;
  }

  /**
   * The principal a wallet was bound to at a finalized height, from the
   * wallet's binding history. Throws when the history doesn't cover that
   * height, rather than call a bound wallet unbound.
   */
  async principalAt(wallet: string, height: number): Promise<string | null> {
    const chain = this.chain;
    if (!chain) {
      return null;
    }
    const lower = wallet.toLowerCase();
    const key = `${lower}@${height}`;
    const cached = this.bindings.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const history = await chain.getMembershipWalletHistory(lower);
    let principal: string | null = null;
    if (history) {
      const covered =
        height <= history.readHeight &&
        history.ranges.some(([from, to]) => height >= from && height <= to);
      if (!covered) {
        throw new Error(
          `The chain gateway's binding history of ${lower} does not cover height ${height}`
        );
      }
      for (const change of history.changes) {
        if (change.height > height) break;
        principal = change.principalId?.toLowerCase() ?? null;
      }
    }
    this.bindings.set(key, principal);
    return principal;
  }

  async ownerAt(wallet: string, height: number): Promise<string> {
    return (await this.principalAt(wallet, height)) ?? wallet.toLowerCase();
  }

  /**
   * ownerAt for many wallets at a recent height (the latest anchor): one
   * pinned batch read when the client has it, else each wallet's history.
   */
  async ownersAt(
    wallets: readonly string[],
    height: number
  ): Promise<Map<string, string>> {
    const distinct = Array.from(new Set(wallets.map((it) => it.toLowerCase())));
    const owners = new Map<string, string>();
    const chain = this.chain;
    if (chain?.getIdentitiesByWallets && distinct.length) {
      const identities = await chain.getIdentitiesByWallets(distinct, {
        height
      });
      for (const wallet of distinct) {
        const principal = identities[wallet]?.principalId.toLowerCase() ?? null;
        this.bindings.set(`${wallet}@${height}`, principal);
        owners.set(wallet, principal ?? wallet);
      }
      return owners;
    }
    for (const wallet of distinct) {
      owners.set(wallet, await this.ownerAt(wallet, height));
    }
    return owners;
  }

  async profileIdOf(owner: string): Promise<string | null> {
    const normalized = owner.toLowerCase();
    if (isWalletAddress(normalized)) {
      return this.profiles.getProfileIdByWallet(normalized);
    }
    if (!this.chain) {
      return null;
    }
    const identity = await this.chain.getIdentityByPrincipal(normalized);
    if (!identity) {
      return null;
    }
    if (identity.legacyId) {
      return identity.legacyId;
    }
    for (const wallet of identity.wallets) {
      const profileId = await this.profiles.getProfileIdByWallet(
        wallet.toLowerCase()
      );
      if (profileId) {
        return profileId;
      }
    }
    return null;
  }
}

export const recordOwnerDirectory = new ChainRecordOwnerDirectory({
  getProfileIdByWallet: (wallet) => identitiesDb.getProfileIdByWallet(wallet)
});
