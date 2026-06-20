import {
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
import { stripHelpBotSelfIntro } from './help-bot-response-text';

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
const TDH_GLOBAL_METRICS = ['total_tdh'] as const;
const QUERY_PLAN_KEYS = [
  'entity',
  'operation',
  'metric',
  'filters',
  'limit'
] as const;

const DATA_QUESTION_PATTERN =
  /\b(how many|count|highest|lowest|max|min|total|sum|average|avg|edition size|tdh rate|hodl rate|supply|szn|season|meme\s*#?\d+|current tdh)\b/i;

function isPotentialPublicDataQuestion(question: string): boolean {
  return DATA_QUESTION_PATTERN.test(question);
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

function compactValue(value: unknown): string {
  if (value === null || value === undefined) {
    return 'none';
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? value.toLocaleString('en-US') : `${value}`;
  }
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
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
    return `I found no matching public data for ${title}.\n\nMore info: ${canonicalUrl}`;
  }
  const firstRow = rows[0];
  const valueText =
    rows.length === 1
      ? Object.entries(firstRow).length === 1
        ? compactValue(Object.values(firstRow)[0])
        : compactRow(firstRow)
      : rows.map((row, index) => `${index + 1}. ${compactRow(row)}`).join('\n');
  return `${title}: ${valueText}\n\nMore info: ${canonicalUrl}`;
}

function normalizeRenderedDataAnswer(
  text: string,
  canonicalUrl: string
): string {
  const compact = stripHelpBotSelfIntro(text).replace(/\n{3,}/g, '\n\n');
  const withUrl = compact.includes(canonicalUrl)
    ? compact
    : `${compact}\n\nMore info: ${canonicalUrl}`;
  return withUrl.length <= 1200 ? withUrl : `${withUrl.slice(0, 1197)}...`;
}

function readStringEnum<T extends string>(
  value: unknown,
  allowed: readonly T[]
): T | null {
  return typeof value === 'string' && allowed.includes(value as T)
    ? (value as T)
    : null;
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
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value)
        ? Number(value)
        : null;
  return parsed !== null &&
    Number.isInteger(parsed) &&
    parsed > 0 &&
    parsed <= max
    ? parsed
    : null;
}

function readLimit(value: unknown): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value)
        ? Number(value)
        : null;
  if (parsed === null || !Number.isInteger(parsed) || parsed <= 0) {
    return 1;
  }
  return Math.min(parsed, HELP_BOT_PUBLIC_DATA_MAX_ROWS);
}

function hasOnlyKnownPlanKeys(plan: HelpBotPublicDataQueryPlan): boolean {
  return Object.keys(plan).every((key) =>
    QUERY_PLAN_KEYS.includes(key as never)
  );
}

function readMemeCardFilters(
  filters: Record<string, unknown>
): MemeCardFilterValues | null {
  const unknownKeys = Object.keys(filters).filter(
    (key) => !MEME_CARD_FILTER_KEYS.includes(key as never)
  );
  if (unknownKeys.length) {
    return null;
  }
  const meme =
    filters.meme === undefined
      ? undefined
      : readPositiveInteger(filters.meme, 100_000);
  const season =
    filters.season === undefined
      ? undefined
      : readPositiveInteger(filters.season, 10_000);
  if (
    (filters.meme !== undefined && meme === null) ||
    (filters.season !== undefined && season === null)
  ) {
    return null;
  }
  return { meme: meme ?? undefined, season: season ?? undefined };
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
  if (!metric?.requiresNfts) {
    return {
      fromSql: `FROM ${MEMES_EXTENDED_DATA_TABLE} m`,
      params: {}
    };
  }
  return {
    fromSql: `FROM ${MEMES_EXTENDED_DATA_TABLE} m JOIN ${NFTS_TABLE} n ON n.id = m.id AND n.contract = :memesContract`,
    params: { memesContract: MEMES_CONTRACT }
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
    canonicalPath: canonicalMemeCardsPath(filters)
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
    const canonicalUrl = toCanonicalUrl(query.canonicalPath);

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
          answer: normalizeRenderedDataAnswer(rendered, canonicalUrl),
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
