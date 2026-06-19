import { DbPoolName } from '@/db-query.options';
import { SqlExecutor, dbSupplier } from '@/sql-executor';
import {
  HELP_BOT_BASE_URL,
  HELP_BOT_BEDROCK_TIMEOUT_MS,
  HELP_BOT_PUBLIC_DATA_MAX_ROWS,
  HELP_BOT_PUBLIC_DATA_QUERY_TIMEOUT_MS
} from './help-bot.config';
import { HELP_BOT_PUBLIC_DATA_CATALOG } from './help-bot-public-data.catalog';

export interface HelpBotPublicDataAnswerRequest {
  readonly question: string;
  readonly previousBotAnswer?: string | null;
}

export const HELP_BOT_PUBLIC_DATA_QUERY_IDS = [
  'memes_in_season_count',
  'meme_tdh_rate',
  'highest_tdh_rate',
  'highest_edition_size',
  'highest_supply',
  'total_tdh'
] as const;

export type HelpBotPublicDataQueryId =
  (typeof HELP_BOT_PUBLIC_DATA_QUERY_IDS)[number];

export interface HelpBotPublicDataQueryPlan {
  readonly queryId: string;
  readonly params?: Record<string, unknown>;
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
  readonly sql: string;
}

interface HelpBotPublicDataExecutableQuery {
  readonly queryId: HelpBotPublicDataQueryId;
  readonly sql: string;
  readonly params?: Record<string, unknown>;
  readonly title: string;
  readonly canonicalPath: string;
}

const DATA_QUESTION_PATTERN =
  /\b(how many|count|highest|lowest|max|min|total|sum|average|avg|edition size|tdh rate|hodl rate|supply|szn|season|meme\s*#?\d+)\b/i;

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
  const entries = Object.entries(firstRow);
  const valueText =
    entries.length === 1
      ? compactValue(entries[0][1])
      : entries
          .map(([key, value]) => `${key}: ${compactValue(value)}`)
          .join(', ');
  return `${title}: ${valueText}\n\nMore info: ${canonicalUrl}`;
}

function normalizeRenderedDataAnswer(
  text: string,
  canonicalUrl: string
): string {
  const compact = text.trim().replace(/\n{3,}/g, '\n\n');
  const withUrl = compact.includes(canonicalUrl)
    ? compact
    : `${compact}\n\nMore info: ${canonicalUrl}`;
  return withUrl.length <= 1200 ? withUrl : `${withUrl.slice(0, 1197)}...`;
}

function readQueryId(value: string): HelpBotPublicDataQueryId | null {
  return HELP_BOT_PUBLIC_DATA_QUERY_IDS.includes(
    value as HelpBotPublicDataQueryId
  )
    ? (value as HelpBotPublicDataQueryId)
    : null;
}

function readPlanParams(
  params: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (!params || Array.isArray(params) || typeof params !== 'object') {
    return {};
  }
  return params;
}

function readPositiveIntegerParam(
  params: Record<string, unknown>,
  key: string,
  max: number
): number | null {
  const raw = params[key];
  const value =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && /^\d+$/.test(raw)
        ? Number(raw)
        : null;
  return value !== null && Number.isInteger(value) && value > 0 && value <= max
    ? value
    : null;
}

export function buildHelpBotPublicDataQuery(
  plan: HelpBotPublicDataQueryPlan
): HelpBotPublicDataExecutableQuery | null {
  const queryId = readQueryId(plan.queryId);
  if (!queryId) {
    return null;
  }
  const params = readPlanParams(plan.params);

  switch (queryId) {
    case 'memes_in_season_count': {
      const season = readPositiveIntegerParam(params, 'season', 10_000);
      if (season === null) {
        return null;
      }
      return {
        queryId,
        sql: `SELECT COUNT(*) AS meme_count FROM memes_extended_data WHERE season = :season LIMIT ${HELP_BOT_PUBLIC_DATA_MAX_ROWS}`,
        params: { season },
        title: `Meme Cards in SZN${season}`,
        canonicalPath: `/the-memes?szn=${season}`
      };
    }
    case 'meme_tdh_rate': {
      const meme = readPositiveIntegerParam(params, 'meme', 100_000);
      if (meme === null) {
        return null;
      }
      return {
        queryId,
        sql: `SELECT m.meme, m.meme_name, n.hodl_rate AS tdh_rate FROM memes_extended_data m JOIN nfts n ON n.id = m.id WHERE m.meme = :meme LIMIT 1`,
        params: { meme },
        title: `Meme #${meme} TDH Rate`,
        canonicalPath: `/the-memes/${meme}`
      };
    }
    case 'highest_tdh_rate':
      return {
        queryId,
        sql: 'SELECT m.meme, m.meme_name, n.hodl_rate AS tdh_rate FROM memes_extended_data m JOIN nfts n ON n.id = m.id ORDER BY n.hodl_rate DESC LIMIT 1',
        title: 'Highest Meme Card TDH Rate',
        canonicalPath: '/the-memes'
      };
    case 'highest_edition_size':
      return {
        queryId,
        sql: 'SELECT meme, meme_name, edition_size FROM memes_extended_data ORDER BY edition_size DESC LIMIT 1',
        title: 'Highest Meme Card Edition Size',
        canonicalPath: '/the-memes'
      };
    case 'highest_supply':
      return {
        queryId,
        sql: 'SELECT m.meme, m.meme_name, n.supply FROM memes_extended_data m JOIN nfts n ON n.id = m.id ORDER BY n.supply DESC LIMIT 1',
        title: 'Highest Meme Card Supply',
        canonicalPath: '/the-memes'
      };
    case 'total_tdh':
      return {
        queryId,
        sql: 'SELECT total_boosted_tdh AS total_tdh, date, block FROM latest_tdh_global_history LIMIT 1',
        title: 'Total TDH',
        canonicalPath: '/network/tdh'
      };
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
        applyStatementTimeoutHint(query.sql),
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
          sql: query.sql
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
      sql: query.sql
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
