import { ADDRESS_CONSOLIDATION_KEY, IDENTITIES_TABLE } from '@/constants';
import { DbQueryOptions } from '@/db-query.options';
import { sqlExecutor } from '@/sql-executor';

/**
 * The identity mirror's principal table (PR #2516). Named here
 * until that table's constant is on main; then this becomes an import.
 */
const IDENTITY_CHAIN_PRINCIPALS = 'identity_chain_principals';
const CHUNK = 500;

/**
 * Which identity a wallet belongs to now: a 6529 chain principal id for a
 * bound wallet, else the wallet itself (lowercase). The subscription tables
 * key everything by this.
 */
export interface IdentityDirectory {
  /** Each wallet (any case) to its identity key, keyed by the lowercase wallet. */
  identitiesOf(
    wallets: readonly string[],
    options?: DbQueryOptions
  ): Promise<Map<string, string>>;
  /**
   * Each identity to the consolidation key the legacy tables use for it now
   * (the identity's wallets, sorted and joined by "-"): what eligibility and
   * the airdrop rule still read by.
   */
  consolidationKeysOf(
    identityKeys: readonly string[],
    options?: DbQueryOptions
  ): Promise<Map<string, string>>;
}

const PRINCIPAL = /^0x[0-9a-f]{64}$/;

export function isPrincipalId(key: string): boolean {
  return PRINCIPAL.test(key.toLowerCase());
}

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) {
    out.push(items.slice(i, i + CHUNK));
  }
  return out;
}

/**
 * The directory the identity mirror keeps: a wallet's row in
 * address_consolidation_keys names its consolidation key, the identity row
 * with that key names the profile, and identity_chain_principals names the
 * profile's principal. A wallet without that chain is its own identity.
 */
export class MirrorIdentityDirectory implements IdentityDirectory {
  async identitiesOf(
    wallets: readonly string[],
    options?: DbQueryOptions
  ): Promise<Map<string, string>> {
    const lower = Array.from(new Set(wallets.map((w) => w.toLowerCase())));
    const result = new Map<string, string>();
    for (const wallet of lower) {
      result.set(wallet, wallet);
    }
    for (const chunk of chunks(lower)) {
      const rows = await sqlExecutor.execute<{
        address: string;
        principal_id: string;
      }>(
        `SELECT LOWER(a.address) AS address, LOWER(p.principal_id) AS principal_id
           FROM ${ADDRESS_CONSOLIDATION_KEY} a
           JOIN ${IDENTITIES_TABLE} i ON i.consolidation_key = a.consolidation_key
           JOIN ${IDENTITY_CHAIN_PRINCIPALS} p ON p.profile_id = i.profile_id
          WHERE LOWER(a.address) IN (:chunk)`,
        { chunk },
        options
      );
      for (const row of rows) {
        result.set(row.address, row.principal_id);
      }
    }
    return result;
  }

  async consolidationKeysOf(
    identityKeys: readonly string[],
    options?: DbQueryOptions
  ): Promise<Map<string, string>> {
    const lower = Array.from(new Set(identityKeys.map((k) => k.toLowerCase())));
    const result = new Map<string, string>();
    const principals = lower.filter(isPrincipalId);
    const wallets = lower.filter((k) => !isPrincipalId(k));
    for (const wallet of wallets) {
      result.set(wallet, wallet);
    }
    for (const chunk of chunks(principals)) {
      const rows = await sqlExecutor.execute<{
        principal_id: string;
        consolidation_key: string;
      }>(
        `SELECT LOWER(p.principal_id) AS principal_id, i.consolidation_key
           FROM ${IDENTITY_CHAIN_PRINCIPALS} p
           JOIN ${IDENTITIES_TABLE} i ON i.profile_id = p.profile_id
          WHERE LOWER(p.principal_id) IN (:chunk)`,
        { chunk },
        options
      );
      for (const row of rows) {
        result.set(row.principal_id, row.consolidation_key.toLowerCase());
      }
    }
    for (const chunk of chunks(wallets)) {
      const rows = await sqlExecutor.execute<{
        address: string;
        consolidation_key: string;
      }>(
        `SELECT LOWER(address) AS address, consolidation_key
           FROM ${ADDRESS_CONSOLIDATION_KEY} WHERE LOWER(address) IN (:chunk)`,
        { chunk },
        options
      );
      for (const row of rows) {
        result.set(row.address, row.consolidation_key.toLowerCase());
      }
    }
    return result;
  }
}

/**
 * A fixed wallet-to-identity map, from a file (the Identities export for a
 * rehearsal) or a test. Wallets it doesn't list are their own identity.
 */
export class MapIdentityDirectory implements IdentityDirectory {
  private readonly byWallet: ReadonlyMap<string, string>;

  constructor(walletToIdentity: Record<string, string>) {
    const map = new Map<string, string>();
    for (const [wallet, identity] of Object.entries(walletToIdentity)) {
      map.set(wallet.toLowerCase(), identity.toLowerCase());
    }
    this.byWallet = map;
  }

  async identitiesOf(wallets: readonly string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    for (const wallet of wallets.map((w) => w.toLowerCase())) {
      result.set(wallet, this.byWallet.get(wallet) ?? wallet);
    }
    return result;
  }

  async consolidationKeysOf(
    identityKeys: readonly string[]
  ): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    for (const identity of identityKeys.map((k) => k.toLowerCase())) {
      const wallets = Array.from(this.byWallet.entries())
        .filter(([, id]) => id === identity)
        .map(([wallet]) => wallet)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      result.set(identity, wallets.length ? wallets.join('-') : identity);
    }
    return result;
  }
}

export const mirrorIdentityDirectory = new MirrorIdentityDirectory();
