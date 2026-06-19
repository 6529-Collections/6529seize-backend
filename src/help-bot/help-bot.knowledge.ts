import { Logger } from '@/logging';
import { getHelpBotConfig } from './help-bot.config';

export interface HelpBotKnowledgeRecord {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly canonicalPath: string;
  readonly aliases: string[];
  readonly keywords: string[];
  readonly facts: string[];
  readonly relatedPaths: string[];
  readonly tags: string[];
  readonly sourceRefs: string[];
}

export interface HelpBotKnowledgeIndex {
  readonly schemaVersion: number;
  readonly generatedAt: string;
  readonly commitSha: string;
  readonly baseUrl: string;
  readonly records: HelpBotKnowledgeRecord[];
}

export interface HelpBotKnowledgeMatch {
  readonly record: HelpBotKnowledgeRecord;
  readonly score: number;
}

export interface HelpBotKnowledgeSource {
  findMatch(question: string): Promise<HelpBotKnowledgeMatch | null>;
}

interface HelpBotIndexResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

type HelpBotIndexFetcher = (url: string) => Promise<HelpBotIndexResponse>;

const MINIMUM_MATCH_SCORE = 2;
const DEFAULT_COMMIT_SHA = 'unknown';
const logger = Logger.get('HelpBotKnowledge');

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .map((item) => readString(item))
        .filter((item): item is string => !!item)
    : [];
}

function readCanonicalPath(raw: Record<string, unknown>): string | null {
  return readString(raw.canonicalPath) ?? readString(raw.canonical_path);
}

function readSourceRefs(raw: Record<string, unknown>): string[] {
  return readStringArray(raw.sourceRefs).concat(
    readStringArray(raw.source_refs)
  );
}

function normalizeRecord(value: unknown): HelpBotKnowledgeRecord | null {
  const raw = asRecord(value);
  if (!raw) {
    return null;
  }
  const id = readString(raw.id);
  const title = readString(raw.title);
  const canonicalPath = readCanonicalPath(raw);
  const facts = readStringArray(raw.facts);
  if (!id || !title || !canonicalPath || !facts.length) {
    return null;
  }
  const aliases = readStringArray(raw.aliases);
  const keywords = readStringArray(raw.keywords);
  return {
    id,
    kind: readString(raw.kind) ?? 'curated',
    title,
    canonicalPath,
    aliases: aliases.length ? aliases : [title],
    keywords: keywords.length ? keywords : aliases.concat([title]),
    facts,
    relatedPaths: readStringArray(raw.relatedPaths).concat(
      readStringArray(raw.related_paths)
    ),
    tags: readStringArray(raw.tags),
    sourceRefs: readSourceRefs(raw)
  };
}

function normalizeIndex(value: unknown): HelpBotKnowledgeIndex | null {
  const raw = asRecord(value);
  if (!raw) {
    return null;
  }
  const records = Array.isArray(raw.records)
    ? raw.records
        .map((record) => normalizeRecord(record))
        .filter((record): record is HelpBotKnowledgeRecord => !!record)
    : [];
  if (!records.length) {
    return null;
  }
  return {
    schemaVersion:
      typeof raw.schema_version === 'number'
        ? raw.schema_version
        : Number(raw.schemaVersion ?? 1),
    generatedAt:
      readString(raw.generated_at) ??
      readString(raw.generatedAt) ??
      new Date(0).toISOString(),
    commitSha:
      readString(raw.commit_sha) ??
      readString(raw.commitSha) ??
      DEFAULT_COMMIT_SHA,
    baseUrl: readString(raw.base_url) ?? readString(raw.baseUrl) ?? '',
    records
  };
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9+#/{}]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function tokenize(value: string): Set<string> {
  return new Set(
    normalizeText(value)
      .split(' ')
      .filter((token) => token.length > 1 || token === '+')
  );
}

function phraseScore(question: string, record: HelpBotKnowledgeRecord): number {
  return record.aliases.reduce((score, alias) => {
    return question.includes(normalizeText(alias)) ? score + 3 : score;
  }, 0);
}

function keywordScore(
  questionTokens: Set<string>,
  record: HelpBotKnowledgeRecord
): number {
  return record.keywords.reduce((score, keyword) => {
    return questionTokens.has(normalizeText(keyword)) ? score + 1 : score;
  }, 0);
}

function findMatchInRecords(
  question: string,
  records: readonly HelpBotKnowledgeRecord[]
): HelpBotKnowledgeMatch | null {
  const normalizedQuestion = normalizeText(question);
  if (!normalizedQuestion) {
    return null;
  }
  const questionTokens = tokenize(question);
  const matches = records
    .map((record) => ({
      record,
      score:
        phraseScore(normalizedQuestion, record) +
        keywordScore(questionTokens, record)
    }))
    .filter((match) => match.score >= MINIMUM_MATCH_SCORE)
    .sort(
      (a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id)
    );

  return matches[0] ?? null;
}

export class StaticHelpBotKnowledgeSource implements HelpBotKnowledgeSource {
  constructor(private readonly index: HelpBotKnowledgeIndex) {}

  public async findMatch(
    question: string
  ): Promise<HelpBotKnowledgeMatch | null> {
    return findMatchInRecords(question, this.index.records);
  }
}

export class FrontendHelpBotKnowledgeSource implements HelpBotKnowledgeSource {
  private cachedIndex: HelpBotKnowledgeIndex | null = null;
  private cacheExpiresAt = 0;

  constructor(
    private readonly fetcher: HelpBotIndexFetcher = (url) => fetch(url)
  ) {}

  public async findMatch(
    question: string
  ): Promise<HelpBotKnowledgeMatch | null> {
    const index = await this.loadIndex();
    return index ? findMatchInRecords(question, index.records) : null;
  }

  private async loadIndex(): Promise<HelpBotKnowledgeIndex | null> {
    const config = getHelpBotConfig();
    const now = Date.now();
    if (now < this.cacheExpiresAt) {
      return this.cachedIndex;
    }
    try {
      const response = await this.fetcher(config.knowledgeIndexUrl);
      if (!response.ok) {
        throw new Error(`Frontend help index returned HTTP ${response.status}`);
      }
      const index = normalizeIndex(JSON.parse(await response.text()));
      if (!index) {
        throw new Error('Frontend help index is empty or invalid');
      }
      this.cachedIndex = index;
      this.cacheExpiresAt = now + config.knowledgeIndexCacheTtlMs;
      return index;
    } catch (error) {
      this.cacheExpiresAt =
        now + Math.min(config.knowledgeIndexCacheTtlMs, 30_000);
      logger.warn(
        `Could not load frontend help index from ${config.knowledgeIndexUrl}`,
        error
      );
      return this.cachedIndex;
    }
  }
}

export const frontendHelpBotKnowledgeSource =
  new FrontendHelpBotKnowledgeSource();
