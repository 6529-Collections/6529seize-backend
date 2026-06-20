import {
  IDENTITIES_TABLE,
  LATEST_TDH_GLOBAL_HISTORY_TABLE,
  MEMES_CONTRACT,
  MEMES_EXTENDED_DATA_TABLE,
  NFTS_TABLE
} from '@/constants';
import { DbPoolName } from '@/db-query.options';
import { SqlExecutor, dbSupplier } from '@/sql-executor';
import {
  HELP_BOT_BASE_URL,
  HELP_BOT_BEDROCK_TIMEOUT_MS,
  HELP_BOT_PUBLIC_DATA_MAX_ROWS,
  HELP_BOT_PUBLIC_DATA_QUERY_TIMEOUT_MS
} from './help-bot.config';
import { HELP_BOT_PUBLIC_DATA_CATALOG } from './help-bot-public-data.catalog';
import {
  ensureCanonicalMarkdownLink,
  stripHelpBotSelfIntro
} from './help-bot-response-text';

export interface HelpBotPublicDataAnswerRequest {
  readonly question: string;
  readonly previousBotAnswer?: string | null;
}

/**
 * Public-data mode never executes SQL emitted by Bedrock. The model can only
 * choose a semantic plan from this backend-owned public schema. The backend
 * compiler below turns that plan into parameterized SQL.
 *
 * There is intentionally no "LLM SQL validator" here: SQL is not part of the
 * accepted model output surface. Unexpected fields such as sql/rawSql are
 * ignored or rejected before execution depending on where they appear.
 */
export const HELP_BOT_PUBLIC_DATA_ENTITIES = [
  'meme_cards',
  'profiles',
  'tdh_global'
] as const;

export const HELP_BOT_PUBLIC_DATA_OPERATIONS = [
  'count',
  'value',
  'max',
  'min',
  'sum',
  'avg',
  'latest'
] as const;

type HelpBotPublicDataEntity = (typeof HELP_BOT_PUBLIC_DATA_ENTITIES)[number];
type HelpBotPublicDataOperation =
  (typeof HELP_BOT_PUBLIC_DATA_OPERATIONS)[number];

export interface HelpBotPublicDataQueryPlan {
  readonly entity?: string | null;
  readonly operation?: string | null;
  readonly metric?: string | null;
  readonly filters?: unknown;
  readonly limit?: unknown;
}

export interface HelpBotPublicDataLlm {
  planPublicDataQuery(input: {
    readonly question: string;
    readonly previousBotAnswer?: string | null;
    readonly catalog: string;
  }): Promise<HelpBotPublicDataQueryPlan | null>;

  renderPublicDataAnswer(input: {
    readonly question: string;
    readonly title: string;
    readonly rows: readonly Record<string, unknown>[];
    readonly canonicalUrl: string;
  }): Promise<string>;
}

export interface HelpBotPublicDataAnswer {
  readonly answer: string;
  readonly queryId: string;
}

interface HelpBotPublicDataExecutableQuery {
  readonly queryId: string;
  readonly compiledSql: string;
  readonly params?: Record<string, unknown>;
  readonly title: string;
  readonly canonicalPath: string;
  readonly canonicalPathFromRows?: (
    rows: readonly Record<string, unknown>[]
  ) => string | null;
}

interface MemeCardMetricDefinition {
  readonly expression: string;
  readonly alias: string;
  readonly label: string;
  readonly requiresNfts?: boolean;
  readonly supportsSum?: boolean;
  readonly supportsAverage?: boolean;
}

interface MemeCardFilterValues {
  readonly meme?: number;
  readonly season?: number;
}

const MEME_CARD_METRIC_KEYS = ['tdh_rate', 'edition_size', 'supply'] as const;

type MemeCardMetric = (typeof MEME_CARD_METRIC_KEYS)[number];

const MEME_CARD_METRICS: Record<MemeCardMetric, MemeCardMetricDefinition> = {
  tdh_rate: {
    expression: 'n.hodl_rate',
    alias: 'tdh_rate',
    label: 'TDH Rate',
    requiresNfts: true,
    supportsAverage: true
  },
  edition_size: {
    expression: 'm.edition_size',
    alias: 'edition_size',
    label: 'Edition Size',
    supportsSum: true,
    supportsAverage: true
  },
  supply: {
    expression: 'n.supply',
    alias: 'supply',
    label: 'Supply',
    requiresNfts: true,
    supportsSum: true,
    supportsAverage: true
  }
};

const MEME_CARD_FILTER_KEYS = ['meme', 'season'] as const;
const PROFILE_METRICS = ['tdh'] as const;
const TDH_GLOBAL_METRICS = ['total_tdh'] as const;
const QUERY_PLAN_KEYS = [
  'entity',
  'operation',
  'metric',
  'filters',
  'limit'
] as const;
const MEME_CARD_FILTER_KEY_SET = new Set<string>(MEME_CARD_FILTER_KEYS);
const QUERY_PLAN_KEY_SET = new Set<string>(QUERY_PLAN_KEYS);

const DATA_QUESTION_TERMS = [
  'how many',
  'count',
  'highest',
  'lowest',
  'max',
  'min',
  'top',
  'total',
  'sum',
  'average',
  'avg',
  'who has',
  'which profile',
  'which user',
  'profile',
  'profiles',
  'user',
  'users',
  'identity',
  'identities',
  'edition size',
  'tdh rate',
  'hodl rate',
  'current tdh',
  'supply',
  'szn',
  'season'
] as const;

const PROFILE_TDH_HINT_TERMS = [
  'profile',
  'profiles',
  'user',
  'users',
  'person',
  'people',
  'identity',
  'identities',
  'handle',
  'handles',
  'account',
  'accounts',
  'holder',
  'holders'
] as const;

const PROFILE_TDH_RANKING_TERMS = [
  'highest',
  'top',
  'most',
  'leader',
  'leaders',
  'rank',
  'ranking',
  'currently',
  'current',
  'value',
  'which',
  'who'
] as const;

const MEME_CARD_HINT_TERMS = [
  'meme',
  'memes',
  'card',
  'cards',
  'nft',
  'nfts',
  'edition',
  'supply',
  'hodl rate',
  'tdh rate'
] as const;

function isPotentialPublicDataQuestion(question: string): boolean {
  return (
    containsAnyNormalizedTerm(
      normalizeIntentText(question),
      DATA_QUESTION_TERMS
    ) || /\bmeme\s*#?\d+\b/i.test(question)
  );
}

function applyStatementTimeoutHint(sql: string): string {
  return sql.replace(
    /^select\b/i,
    `SELECT /*+ MAX_EXECUTION_TIME(${HELP_BOT_PUBLIC_DATA_QUERY_TIMEOUT_MS}) */`
  );
}

function rowsContainAnswer(rows: readonly Record<string, unknown>[]): boolean {
  return rows.some((row) =>
    Object.values(row).some((value) => value !== null && value !== undefined)
  );
}

function toCanonicalUrl(path: string): string {
  if (path.startsWith('http://') || path.startsWith('https://')) {
    return path;
  }
  const normalizedPath = path.startsWith('/') ? path : '/' + path;
  return `${HELP_BOT_BASE_URL}${normalizedPath}`;
}

function normalizeIntentText(value: string | null | undefined): string {
  return (value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9+#@]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function containsNormalizedTerm(text: string, term: string): boolean {
  return ` ${text} `.includes(` ${term} `);
}

function containsAnyNormalizedTerm(
  text: string,
  terms: readonly string[]
): boolean {
  return terms.some((term) => containsNormalizedTerm(text, term));
}

function isProfileTdhQuestion({
  question,
  previousBotAnswer
}: HelpBotPublicDataAnswerRequest): boolean {
  const normalizedQuestion = normalizeIntentText(question);
  const normalizedPreviousAnswer = normalizeIntentText(previousBotAnswer);
  const explicitProfileHint = containsAnyNormalizedTerm(
    normalizedQuestion,
    PROFILE_TDH_HINT_TERMS
  );
  const personQuestionHint = containsNormalizedTerm(
    normalizedQuestion,
    'who has'
  );
  const rankingHint = containsAnyNormalizedTerm(
    normalizedQuestion,
    PROFILE_TDH_RANKING_TERMS
  );
  const questionMentionsTdh = containsNormalizedTerm(normalizedQuestion, 'tdh');
  const previousAnswerMentionsTdh = containsNormalizedTerm(
    normalizedPreviousAnswer,
    'tdh'
  );
  const memeCardHint = containsAnyNormalizedTerm(
    normalizedQuestion,
    MEME_CARD_HINT_TERMS
  );

  if (memeCardHint && !explicitProfileHint) {
    return false;
  }

  return (
    (explicitProfileHint || personQuestionHint) &&
    rankingHint &&
    (questionMentionsTdh || (explicitProfileHint && previousAnswerMentionsTdh))
  );
}

function inferDeterministicPublicDataPlan(
  request: HelpBotPublicDataAnswerRequest
): HelpBotPublicDataQueryPlan | null {
  if (!isProfileTdhQuestion(request)) {
    return null;
  }
  return {
    entity: 'profiles',
    operation: 'max',
    metric: 'tdh',
    filters: {},
    limit: 1
  };
}

function compactValue(value: unknown): string {
  if (value === null || value === undefined) {
    return 'none';
  }
  if (typeof value === 'number') {
    if (Number.isInteger(value)) {
      return value.toLocaleString('en-US');
    }
    return `${value}`;
  }
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return `${value}`;
}

function compactRow(row: Record<string, unknown>): string {
  return Object.entries(row)
    .map(([key, value]) => `${key}: ${compactValue(value)}`)
    .join(', ');
}

function sqlJoin(parts: readonly string[]): string {
  return parts.filter(Boolean).join(' ');
}

function buildDeterministicDataAnswer({
  title,
  rows,
  canonicalUrl
}: {
  readonly title: string;
  readonly rows: readonly Record<string, unknown>[];
  readonly canonicalUrl: string;
}): string {
  if (!rows.length) {
    return ensureCanonicalMarkdownLink({
      text: `I found no matching public data for ${title}.`,
      canonicalUrl,
      label: title
    });
  }
  const valueText = compactRows(rows);
  return ensureCanonicalMarkdownLink({
    text: `${title}: ${valueText}`,
    canonicalUrl,
    label: title
  });
}

function compactRows(rows: readonly Record<string, unknown>[]): string {
  if (rows.length !== 1) {
    return rows
      .map((row, index) => `${index + 1}. ${compactRow(row)}`)
      .join('\n');
  }
  const entries = Object.entries(rows[0]);
  if (entries.length === 1) {
    return compactValue(entries[0][1]);
  }
  return compactRow(rows[0]);
}

function normalizeRenderedDataAnswer(
  text: string,
  canonicalUrl: string,
  label: string
): string {
  const withUrl = ensureCanonicalMarkdownLink({
    text: stripHelpBotSelfIntro(text),
    canonicalUrl,
    label
  });
  if (withUrl.length <= 1200) {
    return withUrl;
  }
  return `${withUrl.slice(0, 1197)}...`;
}

function readStringEnum<T extends string>(
  value: unknown,
  allowed: readonly T[]
): T | null {
  if (typeof value !== 'string') {
    return null;
  }
  return allowed.find((allowedValue) => allowedValue === value) ?? null;
}

function readPlanFilters(filters: unknown): Record<string, unknown> | null {
  if (!filters) {
    return {};
  }
  return typeof filters === 'object' && !Array.isArray(filters)
    ? (filters as Record<string, unknown>)
    : null;
}

function readPositiveInteger(value: unknown, max: number): number | null {
  const parsed = readIntegerValue(value);
  if (
    parsed === null ||
    !Number.isInteger(parsed) ||
    parsed <= 0 ||
    parsed > max
  ) {
    return null;
  }
  return parsed;
}

function readLimit(value: unknown): number {
  const parsed = readIntegerValue(value);
  if (parsed === null || !Number.isInteger(parsed) || parsed <= 0) {
    return 1;
  }
  return Math.min(parsed, HELP_BOT_PUBLIC_DATA_MAX_ROWS);
}

function readIntegerValue(value: unknown): number | null {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    return Number(value);
  }
  return null;
}

function hasOnlyKnownPlanKeys(plan: HelpBotPublicDataQueryPlan): boolean {
  return Object.keys(plan).every((key) => QUERY_PLAN_KEY_SET.has(key));
}

function readMemeCardFilters(
  filters: Record<string, unknown>
): MemeCardFilterValues | null {
  const unknownKeys = Object.keys(filters).filter(
    (key) => !MEME_CARD_FILTER_KEY_SET.has(key)
  );
  if (unknownKeys.length) {
    return null;
  }
  const meme = readOptionalPositiveInteger(filters.meme, 100_000);
  const season = readOptionalPositiveInteger(filters.season, 10_000);
  if (
    (filters.meme !== undefined && meme === null) ||
    (filters.season !== undefined && season === null)
  ) {
    return null;
  }
  return { meme: meme ?? undefined, season: season ?? undefined };
}

function readOptionalPositiveInteger(
  value: unknown,
  max: number
): number | null | undefined {
  return value === undefined ? undefined : readPositiveInteger(value, max);
}

function buildMemeCardsWhere(filters: MemeCardFilterValues): {
  readonly whereSql: string;
  readonly params: Record<string, unknown>;
} {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};
  if (filters.meme !== undefined) {
    clauses.push('m.meme = :meme');
    params.meme = filters.meme;
  }
  if (filters.season !== undefined) {
    clauses.push('m.season = :season');
    params.season = filters.season;
  }
  return {
    whereSql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
    params
  };
}

function canonicalMemeCardsPath(filters: MemeCardFilterValues): string {
  if (filters.meme !== undefined) {
    return `/the-memes/${filters.meme}`;
  }
  if (filters.season !== undefined) {
    return `/the-memes?szn=${filters.season}`;
  }
  return '/the-memes';
}

function canonicalMemeCardPathFromRows(
  rows: readonly Record<string, unknown>[]
): string | null {
  if (rows.length !== 1) {
    return null;
  }
  const meme = rows[0]?.meme;
  if (typeof meme === 'number' && Number.isInteger(meme) && meme > 0) {
    return `/the-memes/${meme}`;
  }
  return null;
}

function describeMemeCardsScope(filters: MemeCardFilterValues): string {
  if (filters.meme !== undefined) {
    return `Meme #${filters.meme}`;
  }
  if (filters.season !== undefined) {
    return `Meme Cards in SZN${filters.season}`;
  }
  return 'Meme Cards';
}

function titleCaseOperation(operation: HelpBotPublicDataOperation): string {
  switch (operation) {
    case 'max':
      return 'Highest';
    case 'min':
      return 'Lowest';
    case 'sum':
      return 'Total';
    case 'avg':
      return 'Average';
    default:
      return '';
  }
}

function buildMemeCardsFromSql(metric?: MemeCardMetricDefinition): {
  readonly fromSql: string;
  readonly params: Record<string, unknown>;
} {
  if (metric?.requiresNfts) {
    return {
      fromSql: `FROM ${MEMES_EXTENDED_DATA_TABLE} m JOIN ${NFTS_TABLE} n ON n.id = m.id AND n.contract = :memesContract`,
      params: { memesContract: MEMES_CONTRACT }
    };
  }
  return {
    fromSql: `FROM ${MEMES_EXTENDED_DATA_TABLE} m`,
    params: {}
  };
}

function readMemeCardMetric(metric: unknown): MemeCardMetric | null {
  return readStringEnum(metric, MEME_CARD_METRIC_KEYS);
}

function buildQueryId(
  entity: HelpBotPublicDataEntity,
  operation: HelpBotPublicDataOperation,
  metric?: string
): string {
  return [entity, operation, metric].filter(Boolean).join('.');
}

function buildMemeCardsCountQuery(
  filters: MemeCardFilterValues
): HelpBotPublicDataExecutableQuery {
  const where = buildMemeCardsWhere(filters);
  const from = buildMemeCardsFromSql();
  return {
    queryId: buildQueryId('meme_cards', 'count'),
    compiledSql: sqlJoin([
      'SELECT COUNT(*) AS meme_count',
      from.fromSql,
      where.whereSql,
      'LIMIT 1'
    ]),
    params: { ...from.params, ...where.params },
    title: describeMemeCardsScope(filters),
    canonicalPath: canonicalMemeCardsPath(filters)
  };
}

function buildMemeCardsValueQuery(
  metricKey: MemeCardMetric,
  filters: MemeCardFilterValues
): HelpBotPublicDataExecutableQuery | null {
  if (filters.meme === undefined) {
    return null;
  }
  const metric = MEME_CARD_METRICS[metricKey];
  const where = buildMemeCardsWhere(filters);
  const from = buildMemeCardsFromSql(metric);
  return {
    queryId: buildQueryId('meme_cards', 'value', metricKey),
    compiledSql: sqlJoin([
      `SELECT m.meme, m.meme_name, ${metric.expression} AS ${metric.alias}`,
      from.fromSql,
      where.whereSql,
      'LIMIT 1'
    ]),
    params: { ...from.params, ...where.params },
    title: `${describeMemeCardsScope(filters)} ${metric.label}`,
    canonicalPath: canonicalMemeCardsPath(filters)
  };
}

function buildMemeCardsSortedQuery(
  operation: 'max' | 'min',
  metricKey: MemeCardMetric,
  filters: MemeCardFilterValues,
  limit: number
): HelpBotPublicDataExecutableQuery {
  const metric = MEME_CARD_METRICS[metricKey];
  const where = buildMemeCardsWhere(filters);
  const from = buildMemeCardsFromSql(metric);
  const direction = operation === 'max' ? 'DESC' : 'ASC';
  const titlePrefix = titleCaseOperation(operation);
  const scope = filters.season !== undefined ? ` in SZN${filters.season}` : '';
  return {
    queryId: buildQueryId('meme_cards', operation, metricKey),
    compiledSql: sqlJoin([
      `SELECT m.meme, m.meme_name, ${metric.expression} AS ${metric.alias}`,
      from.fromSql,
      where.whereSql,
      `ORDER BY ${metric.expression} ${direction}, m.meme ASC`,
      `LIMIT ${limit}`
    ]),
    params: { ...from.params, ...where.params },
    title: `${titlePrefix} Meme Card ${metric.label}${scope}`,
    canonicalPath: canonicalMemeCardsPath(filters),
    canonicalPathFromRows: canonicalMemeCardPathFromRows
  };
}

function buildMemeCardsAggregateQuery(
  operation: 'sum' | 'avg',
  metricKey: MemeCardMetric,
  filters: MemeCardFilterValues
): HelpBotPublicDataExecutableQuery | null {
  const metric = MEME_CARD_METRICS[metricKey];
  if (
    (operation === 'sum' && !metric.supportsSum) ||
    (operation === 'avg' && !metric.supportsAverage)
  ) {
    return null;
  }
  const where = buildMemeCardsWhere(filters);
  const from = buildMemeCardsFromSql(metric);
  const sqlOperation = operation === 'sum' ? 'SUM' : 'AVG';
  const titlePrefix = titleCaseOperation(operation);
  const scope = filters.season !== undefined ? ` in SZN${filters.season}` : '';
  return {
    queryId: buildQueryId('meme_cards', operation, metricKey),
    compiledSql: sqlJoin([
      `SELECT ${sqlOperation}(${metric.expression}) AS ${metric.alias}`,
      from.fromSql,
      where.whereSql,
      'LIMIT 1'
    ]),
    params: { ...from.params, ...where.params },
    title: `${titlePrefix} Meme Card ${metric.label}${scope}`,
    canonicalPath: canonicalMemeCardsPath(filters)
  };
}

function buildMemeCardsQuery(
  plan: HelpBotPublicDataQueryPlan
): HelpBotPublicDataExecutableQuery | null {
  const operation = readStringEnum(
    plan.operation,
    HELP_BOT_PUBLIC_DATA_OPERATIONS
  );
  if (!operation || operation === 'latest') {
    return null;
  }
  const rawFilters = readPlanFilters(plan.filters);
  if (rawFilters === null) {
    return null;
  }
  const filters = readMemeCardFilters(rawFilters);
  if (!filters) {
    return null;
  }
  if (operation === 'count') {
    return buildMemeCardsCountQuery(filters);
  }
  const metric = readMemeCardMetric(plan.metric);
  if (!metric) {
    return null;
  }
  if (operation === 'value') {
    return buildMemeCardsValueQuery(metric, filters);
  }
  if (operation === 'max' || operation === 'min') {
    return buildMemeCardsSortedQuery(
      operation,
      metric,
      filters,
      readLimit(plan.limit)
    );
  }
  return buildMemeCardsAggregateQuery(operation, metric, filters);
}

function buildTdhGlobalQuery(
  plan: HelpBotPublicDataQueryPlan
): HelpBotPublicDataExecutableQuery | null {
  const operation = readStringEnum(
    plan.operation,
    HELP_BOT_PUBLIC_DATA_OPERATIONS
  );
  const metric = readStringEnum(plan.metric, TDH_GLOBAL_METRICS);
  const filters = readPlanFilters(plan.filters);
  if (
    !metric ||
    filters === null ||
    Object.keys(filters).length ||
    (operation !== 'latest' && operation !== 'value')
  ) {
    return null;
  }
  return {
    queryId: buildQueryId('tdh_global', 'latest', metric),
    compiledSql: `SELECT total_boosted_tdh AS total_tdh, date, block FROM ${LATEST_TDH_GLOBAL_HISTORY_TABLE} LIMIT 1`,
    title: 'Total TDH',
    canonicalPath: '/network/tdh'
  };
}

function readProfileMetric(
  metric: unknown
): (typeof PROFILE_METRICS)[number] | null {
  return readStringEnum(metric, PROFILE_METRICS);
}

function readEmptyFilters(filters: unknown): Record<string, never> | null {
  const rawFilters = readPlanFilters(filters);
  if (rawFilters === null || Object.keys(rawFilters).length) {
    return null;
  }
  return {};
}

function canonicalProfilePathFromRows(
  rows: readonly Record<string, unknown>[]
): string | null {
  if (rows.length !== 1) {
    return null;
  }
  const handle = rows[0]?.handle;
  if (typeof handle !== 'string') {
    return null;
  }
  const routeHandle = handle.trim().replace(/^@+/, '');
  return routeHandle ? `/${encodeURIComponent(routeHandle)}` : null;
}

function buildProfilesQuery(
  plan: HelpBotPublicDataQueryPlan
): HelpBotPublicDataExecutableQuery | null {
  const operation = readStringEnum(
    plan.operation,
    HELP_BOT_PUBLIC_DATA_OPERATIONS
  );
  const metric = readProfileMetric(plan.metric);
  const filters = readEmptyFilters(plan.filters);
  if (!metric || filters === null || operation !== 'max') {
    return null;
  }
  const limit = readLimit(plan.limit);
  return {
    queryId: buildQueryId('profiles', operation, metric),
    compiledSql: sqlJoin([
      `SELECT i.handle, i.tdh AS tdh FROM ${IDENTITIES_TABLE} i`,
      "WHERE i.handle IS NOT NULL AND i.handle <> '' AND i.tdh > 0",
      'ORDER BY i.tdh DESC, i.handle ASC',
      `LIMIT ${limit}`
    ]),
    title: 'Highest Profile TDH',
    canonicalPath: '/network/tdh',
    canonicalPathFromRows: canonicalProfilePathFromRows
  };
}

export function buildHelpBotPublicDataQuery(
  plan: HelpBotPublicDataQueryPlan
): HelpBotPublicDataExecutableQuery | null {
  if (!hasOnlyKnownPlanKeys(plan)) {
    return null;
  }
  const entity = readStringEnum(plan.entity, HELP_BOT_PUBLIC_DATA_ENTITIES);
  if (entity === 'meme_cards') {
    return buildMemeCardsQuery(plan);
  }
  if (entity === 'profiles') {
    return buildProfilesQuery(plan);
  }
  if (entity === 'tdh_global') {
    return buildTdhGlobalQuery(plan);
  }
  return null;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs
        );
      })
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export class HelpBotPublicDataService {
  constructor(
    private readonly llm: HelpBotPublicDataLlm | null,
    private readonly db: () => SqlExecutor = dbSupplier
  ) {}

  public async answer(
    request: HelpBotPublicDataAnswerRequest
  ): Promise<HelpBotPublicDataAnswer | null> {
    const llm = this.llm;
    if (!llm || !isPotentialPublicDataQuestion(request.question)) {
      return null;
    }

    const plan = await this.planQuery(llm, request);
    if (!plan) {
      return null;
    }

    const query = buildHelpBotPublicDataQuery(plan);
    if (!query) {
      return null;
    }
    const rows = await withTimeout(
      this.db().execute<Record<string, unknown>>(
        applyStatementTimeoutHint(query.compiledSql),
        query.params,
        { forcePool: DbPoolName.READ }
      ),
      HELP_BOT_PUBLIC_DATA_QUERY_TIMEOUT_MS,
      'Help bot public data query'
    );
    if (!rowsContainAnswer(rows)) {
      return null;
    }
    const canonicalUrl = toCanonicalUrl(
      query.canonicalPathFromRows?.(rows) ?? query.canonicalPath
    );

    try {
      const rendered = await withTimeout(
        llm.renderPublicDataAnswer({
          question: request.question,
          title: query.title,
          rows,
          canonicalUrl
        }),
        HELP_BOT_BEDROCK_TIMEOUT_MS,
        'Help bot public data rendering'
      );
      if (rendered.trim()) {
        return {
          answer: normalizeRenderedDataAnswer(
            rendered,
            canonicalUrl,
            query.title
          ),
          queryId: query.queryId
        };
      }
    } catch {
      // Deterministic row rendering is good enough when natural wording fails.
    }

    return {
      answer: buildDeterministicDataAnswer({
        title: query.title,
        rows,
        canonicalUrl
      }),
      queryId: query.queryId
    };
  }

  private async planQuery(
    llm: HelpBotPublicDataLlm,
    request: HelpBotPublicDataAnswerRequest
  ): Promise<HelpBotPublicDataQueryPlan | null> {
    const deterministicPlan = inferDeterministicPublicDataPlan(request);
    if (deterministicPlan) {
      return deterministicPlan;
    }
    try {
      return await withTimeout(
        llm.planPublicDataQuery({
          question: request.question,
          previousBotAnswer: request.previousBotAnswer,
          catalog: HELP_BOT_PUBLIC_DATA_CATALOG
        }),
        HELP_BOT_BEDROCK_TIMEOUT_MS,
        'Help bot public data planning'
      );
    } catch {
      return null;
    }
  }
}
