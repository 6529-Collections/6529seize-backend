import {
  ADDRESS_CONSOLIDATION_KEY,
  CIC_STATEMENTS_TABLE,
  DELEGATIONS_TABLE,
  IDENTITIES_TABLE,
  IDENTITY_TDH_SYNC_STATE_TABLE,
  PROFILES_ACTIVITY_LOGS_TABLE,
  PROFILES_TABLE,
  RATINGS_TABLE,
  TDH_BLOCKS_TABLE
} from '@/constants';
import {
  HELP_BOT_CREDIT_CATEGORY,
  HELP_BOT_HANDLE
} from '@/help-bot/help-bot.config';
import {
  IdentityExportDelegation,
  IdentityExportRating
} from './identity-export.types';

/** One read-only query; the CLI binds it to a read-only snapshot. */
export type ReadOnlyQuery = <T>(
  sql: string,
  params?: Record<string, unknown>
) => Promise<T[]>;

/** A MySQL number as the driver returns it (decimals may come as strings). */
type DbNumber = number | string | null;

export interface IdentityRow {
  readonly consolidation_key: string;
  readonly primary_address: string;
  readonly profile_id: string | null;
  readonly classification: string | null;
  readonly sub_classification: string | null;
  readonly pfp: string | null;
  readonly banner1: string | null;
  readonly banner2: string | null;
  readonly tdh: DbNumber;
  readonly xtdh: DbNumber;
  readonly rep: DbNumber;
  readonly cic: DbNumber;
  readonly level_raw: DbNumber;
  /** profiles.external_id; null when the identity has no profile row. */
  readonly p_external_id: string | null;
  readonly p_handle: string | null;
  readonly p_normalised_handle: string | null;
  readonly p_website: string | null;
}

export interface StatementRow {
  readonly id: string;
  readonly profile_id: string;
  readonly statement_group: string;
  readonly statement_type: string;
  readonly statement_value: string;
  readonly statement_comment: string | null;
  readonly crated_at: Date | string | number;
}

/**
 * How far the identities sync has got (identity_tdh_sync_state): every
 * consolidated-TDH write bumps the pending generation and records its block;
 * the synced generation is the last whose identities sync finished.
 */
export interface IdentitySyncProgress {
  readonly pendingGeneration: number;
  readonly pendingBlock: number;
  readonly syncedGeneration: number;
}

/** The latest TDH block 6529.io computed, and its Ethereum timestamp. */
export interface TdhBlock {
  readonly block: number;
  readonly timestampMs: number | null;
}

/** Everything the export reads. Implemented over SQL below, faked in tests. */
export interface IdentityExportSource {
  realHandleProfileIds(): Promise<string[]>;
  multiWalletConsolidationKeys(): Promise<string[]>;
  ratingEdges(): Promise<IdentityExportRating[]>;
  identitiesByProfileIds(profileIds: string[]): Promise<IdentityRow[]>;
  identitiesByConsolidationKeys(keys: string[]): Promise<IdentityRow[]>;
  walletsByConsolidationKeys(keys: string[]): Promise<Map<string, string[]>>;
  statementsByProfileIds(profileIds: string[]): Promise<StatementRow[]>;
  latestTdhBlock(): Promise<TdhBlock | null>;
  /**
   * Raters whose REP or CIC given is over their credit (TDH + xTDH), as the
   * over-rates loop counts them: the help bot's credits left out.
   */
  overCreditRaters(): Promise<number>;
  /**
   * REP and CIC rating edits logged after `sinceMs`, without the over-rates
   * loop's cuts (LOST_TDH) and the help bot's credits.
   */
  ratingEditsSince(sinceMs: number): Promise<number>;
  /** Null when the state rows are missing. */
  identitySyncProgress(): Promise<IdentitySyncProgress | null>;
  /** The help bot's profile id, by its handle; null when it has none. */
  helpBotProfileId(): Promise<string | null>;
  delegations(): Promise<IdentityExportDelegation[]>;
}

const IN_BATCH = 2000;
const DEFAULT_RATINGS_PAGE = 50_000;

const IDENTITY_COLUMNS = `
  i.consolidation_key, i.primary_address, i.profile_id, i.classification,
  i.sub_classification, i.pfp, i.banner1, i.banner2, i.tdh, i.xtdh, i.rep,
  i.cic, i.level_raw, p.external_id as p_external_id, p.handle as p_handle,
  p.normalised_handle as p_normalised_handle, p.website as p_website`;

export function toMillis(value: Date | string | number | null): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === 'number') {
    return value;
  }
  const millis = Date.parse(value.includes('T') ? value : `${value}Z`);
  return Number.isFinite(millis) ? millis : null;
}

async function inBatches<T>(
  values: string[],
  read: (batch: string[]) => Promise<T[]>
): Promise<T[]> {
  const all: T[] = [];
  for (let i = 0; i < values.length; i += IN_BATCH) {
    all.push(...(await read(values.slice(i, i + IN_BATCH))));
  }
  return all;
}

interface RatingRow {
  readonly rater_profile_id: string;
  readonly matter_target_id: string;
  readonly matter: 'REP' | 'CIC';
  readonly matter_category: string;
  readonly rating: number | string;
  readonly last_modified: Date | string | null;
}

export class SqlIdentityExportSource implements IdentityExportSource {
  constructor(
    private readonly query: ReadOnlyQuery,
    private readonly ratingsPage: number = DEFAULT_RATINGS_PAGE
  ) {}

  async realHandleProfileIds(): Promise<string[]> {
    const rows = await this.query<{ profile_id: string }>(
      `select p.external_id as profile_id
       from ${PROFILES_TABLE} p
       join ${IDENTITIES_TABLE} i on i.profile_id = p.external_id
       where lower(p.normalised_handle) not like 'id-0x%'`
    );
    return rows.map((it) => it.profile_id);
  }

  async multiWalletConsolidationKeys(): Promise<string[]> {
    const rows = await this.query<{ consolidation_key: string }>(
      `select consolidation_key
       from ${ADDRESS_CONSOLIDATION_KEY}
       group by consolidation_key
       having count(*) > 1`
    );
    return rows.map((it) => it.consolidation_key);
  }

  /** Every REP and CIC rating that is not zero, in primary key order. */
  async ratingEdges(): Promise<IdentityExportRating[]> {
    const edges: IdentityExportRating[] = [];
    let last: RatingRow | null = null;
    for (;;) {
      const page: RatingRow[] = await this.query<RatingRow>(
        `select rater_profile_id, matter_target_id, matter, matter_category,
                rating, last_modified
         from ${RATINGS_TABLE}
         where matter in ('REP', 'CIC') and rating <> 0
         ${
           last
             ? `and (rater_profile_id, matter_target_id, matter, matter_category)
                  > (:rater, :target, :matter, :category)`
             : ''
         }
         order by rater_profile_id, matter_target_id, matter, matter_category
         limit ${Math.max(1, Math.floor(this.ratingsPage))}`,
        last
          ? {
              rater: last.rater_profile_id,
              target: last.matter_target_id,
              matter: last.matter,
              category: last.matter_category
            }
          : {}
      );
      for (const row of page) {
        edges.push({
          rater_profile_id: row.rater_profile_id,
          target_profile_id: row.matter_target_id,
          matter: row.matter,
          category: row.matter === 'CIC' ? '' : row.matter_category,
          rating: Number(row.rating),
          last_modified_ms: toMillis(row.last_modified)
        });
      }
      if (page.length < this.ratingsPage) {
        return edges;
      }
      last = page[page.length - 1];
    }
  }

  async identitiesByProfileIds(profileIds: string[]): Promise<IdentityRow[]> {
    return inBatches(profileIds, (batch) =>
      this.query<IdentityRow>(
        `select ${IDENTITY_COLUMNS}
         from ${IDENTITIES_TABLE} i
         join ${PROFILES_TABLE} p on p.external_id = i.profile_id
         where i.profile_id in (:batch)`,
        { batch }
      )
    );
  }

  async identitiesByConsolidationKeys(keys: string[]): Promise<IdentityRow[]> {
    return inBatches(keys, (batch) =>
      this.query<IdentityRow>(
        `select ${IDENTITY_COLUMNS}
         from ${IDENTITIES_TABLE} i
         left join ${PROFILES_TABLE} p on p.external_id = i.profile_id
         where i.consolidation_key in (:batch)`,
        { batch }
      )
    );
  }

  async walletsByConsolidationKeys(
    keys: string[]
  ): Promise<Map<string, string[]>> {
    const rows = await inBatches(keys, (batch) =>
      this.query<{ address: string; consolidation_key: string }>(
        `select address, consolidation_key
         from ${ADDRESS_CONSOLIDATION_KEY}
         where consolidation_key in (:batch)`,
        { batch }
      )
    );
    const wallets = new Map<string, string[]>();
    for (const row of rows) {
      const list = wallets.get(row.consolidation_key) ?? [];
      list.push(row.address.toLowerCase());
      wallets.set(row.consolidation_key, list);
    }
    return wallets;
  }

  async statementsByProfileIds(profileIds: string[]): Promise<StatementRow[]> {
    return inBatches(profileIds, (batch) =>
      this.query<StatementRow>(
        `select id, profile_id, statement_group, statement_type,
                statement_value, statement_comment, crated_at
         from ${CIC_STATEMENTS_TABLE}
         where profile_id in (:batch)`,
        { batch }
      )
    );
  }

  async latestTdhBlock(): Promise<TdhBlock | null> {
    const rows = await this.query<{
      block_number: number | string;
      timestamp: Date | string | number | null;
    }>(
      `select block_number, timestamp from ${TDH_BLOCKS_TABLE}
       order by block_number desc limit 1`
    );
    const row = rows[0];
    if (!row) return null;
    return {
      block: Number(row.block_number),
      timestampMs: toMillis(row.timestamp)
    };
  }

  /** As ratingsDb.getOverRateMatters, for REP and CIC only. */
  async overCreditRaters(): Promise<number> {
    const rows = await this.query<{ n: number | string }>(
      `with rate_tallies as (select r.rater_profile_id,
                                    r.matter,
                                    sum(abs(r.rating)) as tally
                             from ${RATINGS_TABLE} r
                             where r.matter in ('REP', 'CIC')
                               and not (
                                 r.matter = 'REP'
                                 and r.matter_category = :helpBotCreditCategory
                                 and exists (
                                   select 1
                                   from ${IDENTITIES_TABLE} help_bot_identity
                                   where help_bot_identity.profile_id = r.rater_profile_id
                                     and (
                                       help_bot_identity.normalised_handle = :helpBotHandle
                                       or lower(help_bot_identity.handle) = :helpBotHandle
                                     )
                                 )
                               )
                             group by 1, 2)
       select count(*) as n
       from rate_tallies rt
                left join ${IDENTITIES_TABLE} i on rt.rater_profile_id = i.profile_id
       where floor(coalesce(i.tdh + i.xtdh, 0)) < abs(rt.tally)`,
      {
        helpBotCreditCategory: HELP_BOT_CREDIT_CATEGORY,
        helpBotHandle: HELP_BOT_HANDLE
      }
    );
    return Number(rows[0]?.n ?? 0);
  }

  async ratingEditsSince(sinceMs: number): Promise<number> {
    const rows = await this.query<{ n: number | string }>(
      `select count(*) as n
       from ${PROFILES_ACTIVITY_LOGS_TABLE}
       where type = 'RATING_EDIT'
         and additional_data_1 in ('REP', 'CIC')
         and created_at > :since
         and coalesce(json_unquote(json_extract(contents, '$.change_reason')), '') <> 'LOST_TDH'
         and left(coalesce(json_unquote(json_extract(contents, '$.change_reason')), ''), 9) <> 'HELP_BOT_'`,
      { since: new Date(sinceMs) }
    );
    return Number(rows[0]?.n ?? 0);
  }

  async identitySyncProgress(): Promise<IdentitySyncProgress | null> {
    const rows = await this.query<{
      id: string;
      generation: number | string;
      block: number | string;
    }>(
      `select id, generation, block from ${IDENTITY_TDH_SYNC_STATE_TABLE}
       where id in ('pending', 'synced')`
    );
    const pending = rows.find((it) => it.id === 'pending');
    const synced = rows.find((it) => it.id === 'synced');
    if (!pending || !synced) return null;
    return {
      pendingGeneration: Number(pending.generation),
      pendingBlock: Number(pending.block),
      syncedGeneration: Number(synced.generation)
    };
  }

  async helpBotProfileId(): Promise<string | null> {
    const rows = await this.query<{ profile_id: string }>(
      `select external_id as profile_id from ${PROFILES_TABLE}
       where normalised_handle = :handle`,
      { handle: HELP_BOT_HANDLE }
    );
    return rows[0]?.profile_id?.toLowerCase() ?? null;
  }

  async delegations(): Promise<IdentityExportDelegation[]> {
    const rows = await this.query<{
      from_address: string;
      to_address: string;
      collection: string;
      use_case: number | string;
      expiry: number | string;
      all_tokens: number | boolean;
      token_id: number | string | null;
      block: number | string;
    }>(
      `select from_address, to_address, collection, use_case, expiry,
              all_tokens, token_id, block
       from ${DELEGATIONS_TABLE}`
    );
    return rows.map((row) => {
      const allTokens = !!Number(row.all_tokens);
      return {
        from_address: row.from_address.toLowerCase(),
        to_address: row.to_address.toLowerCase(),
        collection: row.collection.toLowerCase(),
        use_case: Number(row.use_case),
        expiry: Number(row.expiry),
        all_tokens: allTokens,
        token_id:
          allTokens || row.token_id === null ? null : String(row.token_id),
        block: Number(row.block)
      };
    });
  }
}
