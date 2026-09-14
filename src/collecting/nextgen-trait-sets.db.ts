import {
  ADDRESS_CONSOLIDATION_KEY,
  CONSOLIDATED_WALLETS_TDH_TABLE,
  IDENTITIES_TABLE
} from '@/constants';
import { BadRequestException } from '@/exceptions';
import {
  NEXTGEN_TOKENS_TABLE,
  NEXTGEN_TOKEN_TRAITS_TABLE
} from '@/nextgen/nextgen_constants';
import { calculateLevel } from '@/profiles/profile-level';
import { dbSupplier, SqlExecutor } from '@/sql-executor';

interface TraitDefinition {
  trait: string;
  trait_count: number;
}

interface AccountSetRow {
  account_key: string;
  profile_id: string | null;
  owner: string;
  normalised_handle: string | null;
  handle: string | null;
  consolidation_display: string | null;
  tdh: number;
  xtdh: number;
  rep_score: number;
  distinct_values_count: number;
  [field: string]: string | number | null;
}

interface AccountTraitToken {
  account_key: string;
  token_id: number;
  custody_wallet: string;
  trait: string;
  value: string;
}

export interface NextgenAccountTraitSet {
  account_key: string;
  profile_id: string | null;
  consolidation_key: string;
  /** Legacy identity link only; individual token custody is in token_owners. */
  owner: string;
  custody_wallets: string[];
  normalised_handle: string | null;
  handle: string | null;
  consolidation_display: string | null;
  tdh: number;
  xtdh: number;
  rep_score: number;
  level: number;
  distinct_values_count: number;
  token_values: Array<{
    value: string;
    tokens: number[];
    token_owners: Array<{ token_id: number; wallet: string }>;
  }>;
  trait_sets: Record<string, number>;
}

interface TraitSetRequest {
  collectionId: number;
  traits: string[];
  pageSize: number;
  page: number;
  ultimate: boolean;
  search?: string;
  addresses?: string[];
}

// The address map is keyed by address; identities are keyed by consolidation.
// Resolve that canonical account once, before counting coverage. An unprofiled
// singleton still has a distinct account, rather than joining all NULL profiles.
const accountTokensSql = `
  SELECT n.id AS token_id, n.collection_id, LOWER(n.owner) AS custody_wallet,
    COALESCE(a.consolidation_key, LOWER(n.owner)) AS account_key
  FROM ${NEXTGEN_TOKENS_TABLE} n
  LEFT JOIN ${ADDRESS_CONSOLIDATION_KEY} a ON a.address = LOWER(n.owner)
  WHERE n.collection_id = :collectionId AND n.pending = false AND n.burnt = false
`;

function validateRequest(request: TraitSetRequest): string[] {
  if (
    !Number.isSafeInteger(request.collectionId) ||
    request.collectionId < 1 ||
    !Number.isSafeInteger(request.page) ||
    request.page < 1 ||
    !Number.isSafeInteger(request.pageSize) ||
    request.pageSize < 1 ||
    request.pageSize > 100
  ) {
    throw new BadRequestException('Invalid collection or page');
  }
  const traits = Array.from(
    new Set(
      request.traits.map((trait) => trait.trim().toLowerCase()).filter(Boolean)
    )
  );
  if (
    traits.length > 20 ||
    traits.some((trait) => trait.length > 100) ||
    (request.search?.length ?? 0) > 500
  ) {
    throw new BadRequestException('Too many traits or search terms');
  }
  return traits;
}

function buildSearch(
  request: TraitSetRequest,
  params: Record<string, unknown>
): string {
  if (!request.search) return '';
  const clauses: string[] = [];
  if (request.addresses?.length) {
    params.addresses = request.addresses.map((address) =>
      address.toLowerCase()
    );
    clauses.push(`EXISTS (SELECT 1 FROM account_tokens searched
      WHERE searched.account_key = coverage.account_key AND searched.custody_wallet IN (:addresses))`);
  }
  const terms = request.search
    .split(',')
    .map((term) => term.trim())
    .filter(Boolean);
  terms.forEach((term, index) => {
    params[`search${index}`] = `%${term}%`;
    clauses.push(
      `(i.normalised_handle LIKE :search${index} OR i.handle LIKE :search${index})`
    );
  });
  return clauses.length ? `WHERE (${clauses.join(' OR ')})` : '';
}

function mapAccountSet(
  row: AccountSetRow,
  tokens: AccountTraitToken[],
  definitions: TraitDefinition[],
  ultimate: boolean
) {
  const owned = tokens.filter((token) => token.account_key === row.account_key);
  const wallets = Array.from(
    new Set(owned.map((token) => token.custody_wallet))
  ).sort((a, b) => a.localeCompare(b));
  const values = Array.from(new Set(owned.map((token) => token.value))).sort(
    (a, b) => a.localeCompare(b)
  );
  const traitSets: Record<string, number> = {};
  const legacyCounts: Record<string, number> = {};
  definitions.forEach((definition, index) => {
    const count = Number(row[`trait_count_${index}`] ?? 0);
    traitSets[definition.trait] = count;
    // Only known, safe keys become legacy top-level fields. New consumers use trait_sets.
    if (/^[a-z][a-z0-9_]*$/i.test(definition.trait)) {
      legacyCounts[`${definition.trait.toLowerCase()}_sets`] = count;
    }
  });
  const result: NextgenAccountTraitSet = {
    account_key: row.account_key,
    profile_id: row.profile_id,
    consolidation_key: row.account_key,
    owner: row.owner,
    custody_wallets: wallets,
    normalised_handle: row.normalised_handle,
    handle: row.handle,
    consolidation_display: row.consolidation_display,
    tdh: Number(row.tdh),
    xtdh: Number(row.xtdh),
    rep_score: Number(row.rep_score),
    level: calculateLevel({
      tdh: Number(row.tdh) + Number(row.xtdh),
      rep: Number(row.rep_score)
    }),
    distinct_values_count: Number(row.distinct_values_count),
    token_values: ultimate
      ? []
      : values.map((value) => {
          const matching = owned.filter((token) => token.value === value);
          return {
            value,
            tokens: matching.map((token) => token.token_id),
            token_owners: matching.map((token) => ({
              token_id: token.token_id,
              wallet: token.custody_wallet
            }))
          };
        }),
    trait_sets: traitSets
  };
  return { ...result, ...(ultimate ? legacyCounts : {}) };
}

export class NextgenTraitSetsDb {
  constructor(private readonly getDb: () => SqlExecutor) {}

  private get db(): SqlExecutor {
    return this.getDb();
  }

  async find(request: TraitSetRequest) {
    const traits = validateRequest(request);
    const empty = {
      count: 0,
      page: request.page,
      next: false,
      data: [] as NextgenAccountTraitSet[]
    };
    if (!traits.length) return empty;
    const definitions = await this.db.execute<TraitDefinition>(
      `
      SELECT LOWER(trait) AS trait, COUNT(DISTINCT value) AS trait_count
      FROM ${NEXTGEN_TOKEN_TRAITS_TABLE}
      WHERE collection_id = :collectionId AND LOWER(trait) IN (:traits)
      GROUP BY LOWER(trait) ORDER BY LOWER(trait) ASC
    `,
      { collectionId: request.collectionId, traits }
    );
    if (definitions.length !== traits.length) return empty;

    const params: Record<string, unknown> = {
      collectionId: request.collectionId,
      traits
    };
    const columns: string[] = [];
    const complete: string[] = [];
    definitions.forEach((definition, index) => {
      params[`trait${index}`] = definition.trait;
      params[`required${index}`] = definition.trait_count;
      columns.push(
        `COUNT(DISTINCT CASE WHEN LOWER(t.trait) = :trait${index} THEN t.value END) AS trait_count_${index}`
      );
      complete.push(`trait_count_${index} = :required${index}`);
    });
    const cte = `WITH account_tokens AS (${accountTokensSql}), coverage AS (
      SELECT owned.account_key, COUNT(DISTINCT t.value) AS distinct_values_count, ${columns.join(', ')}
      FROM account_tokens owned
      JOIN ${NEXTGEN_TOKEN_TRAITS_TABLE} t ON t.token_id = owned.token_id AND t.collection_id = owned.collection_id
      WHERE LOWER(t.trait) IN (:traits)
      GROUP BY owned.account_key
      ${request.ultimate ? `HAVING ${complete.join(' AND ')}` : ''}
    )`;
    const relation = `FROM coverage
      LEFT JOIN ${IDENTITIES_TABLE} i ON i.consolidation_key = coverage.account_key
      LEFT JOIN ${CONSOLIDATED_WALLETS_TDH_TABLE} d ON d.consolidation_key = coverage.account_key
        AND d.block = (SELECT MAX(block) FROM ${CONSOLIDATED_WALLETS_TDH_TABLE})
      ${buildSearch(request, params)}`;
    const countResult = await this.db.execute<{ count: number }>(
      `${cte} SELECT COUNT(*) AS count ${relation}`,
      params
    );
    const count = Number(countResult[0]?.count ?? 0);
    if (!count) return empty;
    const rows = await this.db.execute<AccountSetRow>(
      `${cte}
      SELECT coverage.*, i.profile_id,
        COALESCE(i.primary_address, SUBSTRING_INDEX(coverage.account_key, '-', 1)) AS owner,
        i.normalised_handle, i.handle, d.consolidation_display,
        COALESCE(d.boosted_tdh, 0) AS tdh, COALESCE(i.xtdh, 0) AS xtdh, COALESCE(i.rep, 0) AS rep_score
      ${relation}
      ORDER BY coverage.distinct_values_count DESC, coverage.account_key ASC
      LIMIT :limit OFFSET :offset
    `,
      {
        ...params,
        limit: request.pageSize,
        offset: (request.page - 1) * request.pageSize
      }
    );
    const tokens = rows.length
      ? await this.db.execute<AccountTraitToken>(
          `
      WITH account_tokens AS (${accountTokensSql})
      SELECT DISTINCT owned.account_key, owned.token_id, owned.custody_wallet, LOWER(t.trait) AS trait, t.value
      FROM account_tokens owned
      JOIN ${NEXTGEN_TOKEN_TRAITS_TABLE} t ON t.token_id = owned.token_id AND t.collection_id = owned.collection_id
      WHERE owned.account_key IN (:accounts) AND LOWER(t.trait) IN (:traits)
      ORDER BY owned.account_key ASC, owned.token_id ASC, t.value ASC
    `,
          { ...params, accounts: rows.map((row) => row.account_key) }
        )
      : [];
    return {
      count,
      page: request.page,
      next: count > request.pageSize * request.page,
      data: rows.map((row) =>
        mapAccountSet(row, tokens, definitions, request.ultimate)
      )
    };
  }
}

export const nextgenTraitSetsDb = new NextgenTraitSetsDb(dbSupplier);
