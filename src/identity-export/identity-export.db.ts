import {
  ADDRESS_CONSOLIDATION_KEY,
  CIC_STATEMENTS_TABLE,
  CONSOLIDATIONS_TABLE,
  DELEGATIONS_TABLE,
  IDENTITIES_TABLE,
  IDENTITY_TDH_SYNC_STATE_TABLE,
  PROFILES_ACTIVITY_LOGS_TABLE,
  PROFILES_ARCHIVE_TABLE,
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
  /**
   * The block of the last full TDH write (the tdhLoop's daily run; partial
   * writes don't move it); null when no full write is recorded.
   */
  readonly fullWriteBlock?: number | null;
}

/** Raters over their credit: as 6529.io counts it, and by TDH alone. */
export interface OverCreditRaters {
  /** Credit TDH + xTDH: the raters 6529.io's over-rates loop would cut. */
  readonly withXtdh: number;
  /** Credit TDH alone: the raters the chain's credit would cut. */
  readonly tdhOnly: number;
}

/** A REP or CIC rating last changed after the freeze. */
export interface ChangedRating {
  readonly rater_profile_id: string;
  readonly target_profile_id: string;
  readonly matter: string;
  readonly category: string;
  readonly rating: number;
  readonly last_modified_ms: number | null;
}

/**
 * Profile writes after the freeze: logged, by kind; profile rows saved to
 * profiles_archive (every profile save and pfp update writes one, logged
 * or not); and profiles created.
 */
export interface ProfileWrites {
  readonly handle: number;
  readonly classification: number;
  readonly pfp: number;
  readonly banner: number;
  readonly statements: number;
  readonly archived: number;
  readonly saves: number;
  readonly created: number;
}

/** profile_activity_logs types for each kind of profile write. */
export const PROFILE_WRITE_TYPES: Readonly<
  Record<Exclude<keyof ProfileWrites, 'created' | 'saves'>, readonly string[]>
> = {
  handle: ['HANDLE_EDIT'],
  classification: ['CLASSIFICATION_EDIT'],
  pfp: ['PFP_EDIT'],
  banner: ['BANNER_1_EDIT', 'BANNER_2_EDIT'],
  statements: [
    'SOCIALS_EDIT',
    'CONTACTS_EDIT',
    'SOCIAL_VERIFICATION_POST_EDIT',
    'NFT_ACCOUNTS_EDIT',
    'GENERAL_CIC_STATEMENT_EDIT'
  ],
  archived: ['PROFILE_ARCHIVED']
};

/** Consolidations and delegations rows with a block after the TDH block. */
export interface RowsAfterBlock {
  readonly consolidations: number;
  readonly delegations: number;
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
  overCreditRaters(): Promise<OverCreditRaters>;
  /**
   * REP and CIC ratings whose last_modified is after `sinceMs`, zeros
   * included, help-bot credits aside.
   */
  ratingsChangedSince(sinceMs: number): Promise<ChangedRating[]>;
  /**
   * Profile writes logged at or after `sinceMs`, profile rows saved and
   * profiles created since.
   */
  profileWritesSince(sinceMs: number): Promise<ProfileWrites>;
  /**
   * Consolidations and delegations rows with a block after `block` (the
   * TDH block): registered after the TDH was taken.
   */
  rowsAfterBlock(block: number): Promise<RowsAfterBlock>;
  /**
   * REP and CIC rating edits logged after `sinceMs`, without the over-rates
   * loop's cuts (LOST_TDH) and the help bot's credits.
   */
  ratingEditsSince(sinceMs: number): Promise<number>;
  /** Null when the state rows are missing. */
  identitySyncProgress(): Promise<IdentitySyncProgress | null>;
  /** The help bot's profile id, by its handle; null when it has none. */
  helpBotProfileId(): Promise<string | null>;
  /**
   * Every delegations row, by block, then from, to and collection
   * (lowercase, bytewise), use case and token id.
   */
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

  /**
   * As ratingsDb.getOverRateMatters, for REP and CIC only, counting each
   * rater once: by 6529.io's credit and by TDH alone.
   */
  async overCreditRaters(): Promise<OverCreditRaters> {
    const rows = await this.query<{
      with_xtdh: number | string | null;
      tdh_only: number | string | null;
    }>(
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
       select count(distinct case
                when floor(coalesce(i.tdh + i.xtdh, 0)) < abs(rt.tally)
                then rt.rater_profile_id end) as with_xtdh,
              count(distinct case
                when floor(coalesce(i.tdh, 0)) < abs(rt.tally)
                then rt.rater_profile_id end) as tdh_only
       from rate_tallies rt
                left join ${IDENTITIES_TABLE} i on rt.rater_profile_id = i.profile_id`,
      {
        helpBotCreditCategory: HELP_BOT_CREDIT_CATEGORY,
        helpBotHandle: HELP_BOT_HANDLE
      }
    );
    return {
      withXtdh: Number(rows[0]?.with_xtdh ?? 0),
      tdhOnly: Number(rows[0]?.tdh_only ?? 0)
    };
  }

  async ratingsChangedSince(sinceMs: number): Promise<ChangedRating[]> {
    const rows = await this.query<RatingRow>(
      `select rater_profile_id, matter_target_id, matter, matter_category,
              rating, last_modified
       from ${RATINGS_TABLE}
       where matter in ('REP', 'CIC')
         and last_modified >= :since
         and not (matter = 'REP' and lower(trim(matter_category)) = :credit)
       order by rater_profile_id, matter_target_id, matter, matter_category`,
      {
        since: new Date(sinceMs),
        credit: HELP_BOT_CREDIT_CATEGORY.toLowerCase()
      }
    );
    return rows.map((row) => ({
      rater_profile_id: row.rater_profile_id.toLowerCase(),
      target_profile_id: row.matter_target_id.toLowerCase(),
      matter: row.matter,
      category: row.matter === 'CIC' ? '' : row.matter_category,
      rating: Number(row.rating),
      last_modified_ms: toMillis(row.last_modified)
    }));
  }

  async profileWritesSince(sinceMs: number): Promise<ProfileWrites> {
    const types = Object.values(PROFILE_WRITE_TYPES).flat();
    const rows = await this.query<{ type: string; n: number | string }>(
      `select type, count(*) as n
       from ${PROFILES_ACTIVITY_LOGS_TABLE}
       where created_at >= :since and type in (:types)
       group by type`,
      { since: new Date(sinceMs), types }
    );
    const count = (kind: keyof typeof PROFILE_WRITE_TYPES) =>
      rows
        .filter((row) => PROFILE_WRITE_TYPES[kind].includes(row.type))
        .reduce((sum, row) => sum + Number(row.n), 0);
    const [created] = await this.query<{ n: number | string }>(
      `select count(*) as n from ${PROFILES_TABLE} where created_at >= :since`,
      { since: new Date(sinceMs) }
    );
    // A row per profile save or pfp update, written at the time of the
    // write (created_at), whether or not the write was logged.
    const [saves] = await this.query<{ n: number | string }>(
      `select count(*) as n from ${PROFILES_ARCHIVE_TABLE} where created_at >= :since`,
      { since: new Date(sinceMs) }
    );
    return {
      handle: count('handle'),
      classification: count('classification'),
      pfp: count('pfp'),
      banner: count('banner'),
      statements: count('statements'),
      archived: count('archived'),
      saves: Number(saves?.n ?? 0),
      created: Number(created?.n ?? 0)
    };
  }

  async rowsAfterBlock(block: number): Promise<RowsAfterBlock> {
    const [row] = await this.query<{
      consolidations: number | string;
      delegations: number | string;
    }>(
      `select
         (select count(*) from ${CONSOLIDATIONS_TABLE} where block > :block) as consolidations,
         (select count(*) from ${DELEGATIONS_TABLE} where block > :block) as delegations`,
      { block }
    );
    return {
      consolidations: Number(row?.consolidations ?? 0),
      delegations: Number(row?.delegations ?? 0)
    };
  }

  async ratingEditsSince(sinceMs: number): Promise<number> {
    const rows = await this.query<{ n: number | string }>(
      `select count(*) as n
       from ${PROFILES_ACTIVITY_LOGS_TABLE}
       where type = 'RATING_EDIT'
         and additional_data_1 in ('REP', 'CIC')
         and created_at >= :since
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
       where id in ('pending', 'synced', 'full_announce')`
    );
    const pending = rows.find((it) => it.id === 'pending');
    const synced = rows.find((it) => it.id === 'synced');
    const full = rows.find((it) => it.id === 'full_announce');
    if (!pending || !synced) return null;
    // The full write's announcement keeps its block once published.
    const fullBlock = Number(full?.block ?? 0);
    return {
      pendingGeneration: Number(pending.generation),
      pendingBlock: Number(pending.block),
      syncedGeneration: Number(synced.generation),
      fullWriteBlock: fullBlock > 0 ? fullBlock : null
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
       from ${DELEGATIONS_TABLE}
       order by block,
                cast(lower(from_address) as binary),
                cast(lower(to_address) as binary),
                cast(lower(collection) as binary),
                use_case,
                token_id`
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
