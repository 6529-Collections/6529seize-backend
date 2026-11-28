import { GRADIENT_CONTRACT, MEMES_CONTRACT } from '@/constants';
import { Network } from '@/ethereum-rpc/ethereum-rpc-network';
import { NEXTGEN_CORE_CONTRACT } from '@/nextgen/nextgen_constants';
import { consolidationKeyOf } from './p28';

/**
 * 6529.io's TDH for one day, in the shape the comparison needs: each
 * wallet's and each consolidation's boosted TDH, a consolidation's members,
 * boost and per-token base TDH. It is read from the day's two uploads
 * (`site-uploads.ts`) or from the live tables (the shadow ingest).
 *
 * The mapping to the chain follows the validator's compare crate
 * (`crates/compare`, record.rs and fields.rs): a leaf's walletTDH is the
 * wallet row's `boosted_tdh`, its identityTDH the consolidated row's
 * `boosted_tdh`, its cid the cid of the row's wallets, and a token leaf's
 * tokenTDH is `Math.round(token.tdh * boost)` of the consolidated row, the
 * value `tdh_nft.boosted_tdh` holds.
 */

export type SiteCollection = 'memes' | 'gradients' | 'nextgen';

export const SITE_COLLECTIONS: readonly SiteCollection[] = [
  'memes',
  'gradients',
  'nextgen'
];

export const COLLECTION_CONTRACTS: Readonly<Record<SiteCollection, string>> = {
  memes: MEMES_CONTRACT.toLowerCase(),
  gradients: GRADIENT_CONTRACT.toLowerCase(),
  nextgen: NEXTGEN_CORE_CONTRACT[Network.ETH_MAINNET].toLowerCase()
};

export interface SiteToken {
  readonly collection: SiteCollection;
  readonly tokenId: string;
  /** The token's base TDH (`tdh`). */
  readonly tdh: number;
  readonly balance: number;
}

export interface SiteWalletRow {
  readonly wallet: string;
  readonly boostedTdh: number;
  /** A positive balance of a token the TDH rules count. */
  readonly holds: boolean;
}

export interface SiteIdentityRow {
  readonly key: string;
  /** Lowercase, ascending. */
  readonly wallets: readonly string[];
  readonly boostedTdh: number;
  readonly boost: number;
  readonly tokens: readonly SiteToken[];
}

export interface SiteDay {
  readonly block: number;
  /** YYYYMMDD of the day's boundary. */
  readonly date: string;
  readonly wallets: ReadonlyMap<string, SiteWalletRow>;
  readonly identities: ReadonlyMap<string, SiteIdentityRow>;
  readonly notes: readonly string[];
}

export class SiteDayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SiteDayError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** The identity's boosted TDH on one token, as 6529.io computes it. */
export function siteTokenBoostedTdh(token: SiteToken, boost: number): number {
  return Math.round(token.tdh * boost);
}

/** YYYYMMDD of a cycle day's boundary. */
export function dateOfCycleDay(cycleDay: number): string {
  return new Date(cycleDay * 86400 * 1000)
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, '');
}

export function cycleDayOfDate(date: string): number {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(date);
  if (!m) throw new SiteDayError(`${date} is not YYYYMMDD`);
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (dateOfCycleDay(ms / 86400000) !== date) {
    throw new SiteDayError(`${date} is not a calendar date`);
  }
  return ms / 86400000;
}

/**
 * Builds a SiteDay and checks what both sources must hold: one block and
 * date, a wallet in at most one consolidation, keys that match their wallets.
 */
export class SiteDayBuilder {
  private block: number | null = null;
  private date: string | null = null;
  private readonly wallets = new Map<string, SiteWalletRow>();
  private readonly identities = new Map<string, SiteIdentityRow>();
  private readonly identityOfWallet = new Map<string, string>();
  private readonly notes: string[] = [];

  note(text: string) {
    if (!this.notes.includes(text)) this.notes.push(text);
  }

  private day(block: number, date: string, where: string) {
    if (this.block === null) this.block = block;
    if (this.date === null) this.date = date;
    if (this.block !== block || this.date !== date) {
      throw new SiteDayError(
        `${where}: block ${block} date ${date}, other rows have block ${this.block} date ${this.date}`
      );
    }
  }

  addWallet(block: number, date: string, row: SiteWalletRow, where: string) {
    this.day(block, date, where);
    if (this.wallets.has(row.wallet)) {
      throw new SiteDayError(`${where}: wallet ${row.wallet} twice`);
    }
    this.wallets.set(row.wallet, row);
  }

  addIdentity(
    block: number,
    date: string,
    row: SiteIdentityRow,
    where: string
  ) {
    this.day(block, date, where);
    const key = consolidationKeyOf(row.wallets);
    if (key !== row.key) {
      this.note(
        `consolidation_key differs from its sorted wallets (first: ${where})`
      );
    }
    if (this.identities.has(key)) {
      throw new SiteDayError(`${where}: consolidation ${key} twice`);
    }
    for (const w of row.wallets) {
      const other = this.identityOfWallet.get(w);
      if (other !== undefined) {
        throw new SiteDayError(`${where}: wallet ${w} is also in ${other}`);
      }
      this.identityOfWallet.set(w, key);
    }
    this.identities.set(key, { ...row, key });
  }

  build(): SiteDay {
    if (this.block === null || this.date === null) {
      throw new SiteDayError('no rows');
    }
    return {
      block: this.block,
      date: this.date,
      wallets: this.wallets,
      identities: this.identities,
      notes: this.notes
    };
  }
}
