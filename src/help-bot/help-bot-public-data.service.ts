import { SqlExecutor, dbSupplier } from '@/sql-executor';
import {
  HELP_BOT_BASE_URL,
  HELP_BOT_PUBLIC_DATA_MAX_ROWS,
  HELP_BOT_PUBLIC_DATA_QUERY_TIMEOUT_MS
} from './help-bot.config';
import {
  HELP_BOT_PUBLIC_DATA_ALLOWED_TABLES,
  HELP_BOT_PUBLIC_DATA_CATALOG
} from './help-bot-public-data.catalog';

export interface HelpBotPublicDataAnswerRequest {
  readonly question: string;
  readonly previousBotAnswer?: string | null;
}

export interface HelpBotPublicDataQueryPlan {
  readonly sql: string;
  readonly title: string;
  readonly canonicalPath: string;
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

const DATA_QUESTION_PATTERN =
  /\b(how many|count|highest|lowest|max|min|total|sum|average|avg|edition size|tdh rate|hodl rate|supply|szn|season|meme\s*#?\d+)\b/i;

const DANGEROUS_SQL_PATTERN =
  /\b(insert|update|delete|drop|alter|truncate|create|replace|grant|revoke|call|load|outfile|dumpfile|information_schema|performance_schema|mysql)\b/i;

const TABLE_REF_PATTERN = /\b(?:from|join)\s+`?([a-zA-Z0-9_]+)`?/gi;

function isPotentialPublicDataQuestion(question: string): boolean {
  return DATA_QUESTION_PATTERN.test(question);
}

function normalizeSql(sql: string): string {
  return sql.trim().replace(/\s+/g, ' ');
}

function readTableReferences(sql: string): string[] {
  return Array.from(sql.matchAll(TABLE_REF_PATTERN)).map((match) =>
    match[1].toLowerCase()
  );
}

function readLimit(sql: string): number | null {
  const match = /\blimit\s+(\d+)\b/i.exec(sql);
  return match ? Number(match[1]) : null;
}

export function validateHelpBotPublicDataSql(sql: string): string {
  const normalized = normalizeSql(sql);
  if (!normalized) {
    throw new Error('Public data SQL is empty');
  }
  if (!/^select\b/i.test(normalized)) {
    throw new Error('Public data SQL must be a SELECT statement');
  }
  if (/[;]/.test(normalized) || /--|\/\*|\*\//.test(normalized)) {
    throw new Error('Public data SQL must be a single uncommented statement');
  }
  if (DANGEROUS_SQL_PATTERN.test(normalized)) {
    throw new Error('Public data SQL contains a disallowed keyword');
  }

  const tables = readTableReferences(normalized);
  if (!tables.length) {
    throw new Error('Public data SQL must reference a table');
  }
  const disallowedTable = tables.find(
    (table) => !HELP_BOT_PUBLIC_DATA_ALLOWED_TABLES.has(table)
  );
  if (disallowedTable) {
    throw new Error(
      `Public data SQL references disallowed table ${disallowedTable}`
    );
  }

  const limit = readLimit(normalized);
  if (limit !== null && limit > HELP_BOT_PUBLIC_DATA_MAX_ROWS) {
    throw new Error(
      `Public data SQL limit ${limit} exceeds max ${HELP_BOT_PUBLIC_DATA_MAX_ROWS}`
    );
  }
  if (limit === null && !/\b(count|sum|max|min|avg)\s*\(/i.test(normalized)) {
    return `${normalized} LIMIT ${HELP_BOT_PUBLIC_DATA_MAX_ROWS}`;
  }
  return normalized;
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

    let sql: string;
    try {
      sql = validateHelpBotPublicDataSql(plan.sql);
    } catch {
      return null;
    }
    const rows = await withTimeout(
      this.db().execute<Record<string, unknown>>(sql),
      HELP_BOT_PUBLIC_DATA_QUERY_TIMEOUT_MS,
      'Help bot public data query'
    );
    const canonicalUrl = toCanonicalUrl(plan.canonicalPath);

    try {
      const rendered = await this.llm.renderPublicDataAnswer({
        question: request.question,
        title: plan.title,
        rows,
        canonicalUrl
      });
      if (rendered.trim()) {
        return {
          answer: normalizeRenderedDataAnswer(rendered, canonicalUrl),
          sql
        };
      }
    } catch {
      // Deterministic row rendering is good enough when natural wording fails.
    }

    return {
      answer: buildDeterministicDataAnswer({
        title: plan.title,
        rows,
        canonicalUrl
      }),
      sql
    };
  }

  private async planQuery(
    llm: HelpBotPublicDataLlm,
    request: HelpBotPublicDataAnswerRequest
  ): Promise<HelpBotPublicDataQueryPlan | null> {
    try {
      return await llm.planPublicDataQuery({
        question: request.question,
        previousBotAnswer: request.previousBotAnswer,
        catalog: HELP_BOT_PUBLIC_DATA_CATALOG
      });
    } catch {
      return null;
    }
  }
}
