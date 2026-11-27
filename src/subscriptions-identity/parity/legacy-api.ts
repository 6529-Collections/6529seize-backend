import { fetchAllPages, PublicApiClient } from './public-api-client';

/** Public subscription routes of the legacy system, read without credentials. */

export interface LegacyDetails {
  readonly consolidation_key: string;
  readonly last_update: number;
  readonly balance: number;
  readonly automatic: boolean;
  readonly subscribe_all_editions: boolean;
  readonly subscription_eligibility_count: number;
}

export interface LegacyUpcomingStatus {
  readonly subscribed: boolean;
  readonly eligibility: number;
  readonly count?: number;
  readonly source?: 'manual' | 'automatic';
}

export interface LegacyAirdropAddress {
  readonly tdh_wallet: { readonly address: string };
  readonly airdrop_address: { readonly address: string };
}

export interface LegacyLog {
  readonly id: number;
  readonly created_at: string;
  readonly consolidation_key: string;
  readonly log: string;
  readonly additional_info?: string | null;
}

export interface LegacyFinalRow {
  readonly id?: number;
  readonly consolidation_key: string;
  readonly contract: string;
  readonly token_id: number;
  readonly subscribed_count: number;
  readonly airdrop_address: string;
  readonly balance: number;
  readonly subscribed_at: string;
  readonly phase: string | null;
  readonly phase_subscriptions: number;
  readonly phase_position: number;
  readonly redeemed_count: number;
}

export interface LegacyUpload {
  readonly contract: string;
  readonly token_id: number;
  readonly date: string;
  readonly upload_url: string;
}

export interface LegacyRedeemed {
  readonly contract: string;
  readonly token_id: number;
  readonly address: string;
  readonly transaction: string;
  readonly transaction_date: string | null;
  readonly consolidation_key: string;
  readonly value: number;
  readonly balance_after: number;
  readonly count: number;
}

export interface LegacyTopUp {
  readonly hash: string;
  readonly block: number;
  readonly transaction_date: string;
  readonly from_wallet: string;
  readonly amount: number;
}

export interface LegacyPhaseAirdrop {
  readonly wallet: string;
  readonly amount: number;
}

export interface LegacyNormalizedDistribution {
  readonly wallet: string;
  readonly airdrops: number;
  readonly allowlist: ReadonlyArray<{
    readonly phase: string;
    readonly spots: number;
    readonly spots_airdrop: number;
    readonly spots_allowlist: number;
  }> | null;
}

export interface LegacyWaveDrop {
  readonly serial_no: number;
  readonly created_at: number;
  readonly parts: ReadonlyArray<{ readonly content: string | null }>;
}

export interface LegacyIdentity {
  readonly consolidation_key: string;
}

export interface LegacyTransaction {
  readonly transaction: string;
  readonly block: number;
  readonly transaction_date: string | null;
  readonly from_address: string;
  readonly to_address: string;
  readonly contract: string;
  readonly token_id: number;
  readonly token_count: number;
  readonly value: number;
}

const SUBSCRIPTION_PAGE_SIZE = 20;
const DEFAULT_PAGE_SIZE = 50;
const DISTRIBUTION_PAGE_SIZE = 250;

function enc(value: string | number): string {
  return encodeURIComponent(String(value));
}

export class LegacySubscriptionsApi {
  constructor(private readonly client: PublicApiClient) {}

  get requestCount(): number {
    return this.client.requestCount;
  }

  details(key: string): Promise<LegacyDetails | null> {
    return this.client.getJson(
      `/subscriptions/consolidation/details/${enc(key)}`
    );
  }

  /** null once the card has dropped (the route answers 400 then). */
  upcomingStatus(
    key: string,
    tokenId: number
  ): Promise<LegacyUpcomingStatus | null> {
    return this.client.getJson(
      `/subscriptions/consolidation/upcoming-memes/${enc(tokenId)}/${enc(key)}`,
      {},
      [400, 404]
    );
  }

  airdropAddress(key: string): Promise<LegacyAirdropAddress | null> {
    return this.client.getJson(
      `/subscriptions/consolidation/${enc(key)}/airdrop-address`
    );
  }

  /** Newest first, stopping at the first page that reaches `sinceMs`. */
  logs(key: string, sinceMs: number): Promise<LegacyLog[]> {
    return fetchAllPages<LegacyLog>(
      this.client,
      `/subscriptions/consolidation/logs/${enc(key)}`,
      {},
      SUBSCRIPTION_PAGE_SIZE,
      (page) => page.some((log) => Date.parse(log.created_at) < sinceMs)
    );
  }

  topUps(key: string, sinceMs: number): Promise<LegacyTopUp[]> {
    return fetchAllPages<LegacyTopUp>(
      this.client,
      `/subscriptions/consolidation/top-up/${enc(key)}`,
      {},
      SUBSCRIPTION_PAGE_SIZE,
      (page) => page.some((t) => Date.parse(t.transaction_date) < sinceMs)
    );
  }

  redeemed(key: string, sinceMs: number): Promise<LegacyRedeemed[]> {
    return fetchAllPages<LegacyRedeemed>(
      this.client,
      `/subscriptions/consolidation/redeemed/${enc(key)}`,
      {},
      SUBSCRIPTION_PAGE_SIZE,
      (page) =>
        page.some(
          (r) =>
            r.transaction_date !== null &&
            Date.parse(r.transaction_date) < sinceMs
        )
    );
  }

  finalRow(
    key: string,
    contract: string,
    tokenId: number
  ): Promise<LegacyFinalRow | null> {
    return this.client.getJson(
      `/subscriptions/consolidation/final/${enc(key)}/${enc(contract)}/${enc(tokenId)}`
    );
  }

  uploads(contract: string, maxPages: number): Promise<LegacyUpload[]> {
    let pages = 0;
    return fetchAllPages<LegacyUpload>(
      this.client,
      '/subscriptions/uploads',
      { contract },
      SUBSCRIPTION_PAGE_SIZE,
      () => ++pages >= maxPages
    );
  }

  fileText(url: string): Promise<string> {
    return this.client.getText(url);
  }

  async phaseNames(contract: string, tokenId: number): Promise<string[]> {
    const result = await this.client.getJson<{ data: string[] }>(
      `/distribution_phases/${enc(contract)}/${enc(tokenId)}`
    );
    return result?.data ?? [];
  }

  async phaseList(
    contract: string,
    tokenId: number,
    phaseName: string
  ): Promise<LegacyPhaseAirdrop[]> {
    return (
      (await this.client.getJson<LegacyPhaseAirdrop[]>(
        `/subscriptions/final/${enc(contract)}/${enc(tokenId)}/phases/${enc(phaseName)}`
      )) ?? []
    );
  }

  distributions(
    contract: string,
    tokenId: number
  ): Promise<LegacyNormalizedDistribution[]> {
    return fetchAllPages<LegacyNormalizedDistribution>(
      this.client,
      '/distributions',
      { card_id: tokenId, contract: contract.toLowerCase() },
      DISTRIBUTION_PAGE_SIZE
    );
  }

  airdropTransactions(
    contract: string,
    tokenId: number
  ): Promise<LegacyTransaction[]> {
    return fetchAllPages<LegacyTransaction>(
      this.client,
      '/transactions',
      { contract, id: tokenId, filter: 'airdrops' },
      DEFAULT_PAGE_SIZE
    );
  }

  /** A page of a public wave's drops, newest first, older than a serial. */
  async waveDrops(
    waveId: string,
    serialNoLessThan?: number
  ): Promise<LegacyWaveDrop[]> {
    const result = await this.client.getJson<{ drops: LegacyWaveDrop[] }>(
      `/waves/${enc(waveId)}/drops`,
      { limit: 50, serial_no_less_than: serialNoLessThan }
    );
    return result?.drops ?? [];
  }

  identityByWallet(wallet: string): Promise<LegacyIdentity | null> {
    return this.client.getJson(`/identities/by-wallet/${enc(wallet)}`);
  }

  async cardCount(tokenId: number): Promise<number | null> {
    const result = await this.client.getJson<{ count: number }>(
      `/subscriptions/memes/${enc(tokenId)}/count`
    );
    return result ? Number(result.count) : null;
  }
}
