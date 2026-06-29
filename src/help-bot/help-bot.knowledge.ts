import { Logger } from '@/logging';
import {
  HELP_BOT_INDEX_CACHE_TTL_MS,
  HELP_BOT_INDEX_FETCH_TIMEOUT_MS,
  HELP_BOT_INDEX_URL
} from './help-bot.config';

export interface HelpBotKnowledgeRecord {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly linkLabel: string;
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
  findMatches?(
    question: string,
    limit?: number
  ): Promise<HelpBotKnowledgeMatch[]>;
}

interface HelpBotIndexResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

type HelpBotIndexFetcher = (
  url: string,
  timeoutMs: number
) => Promise<HelpBotIndexResponse>;

const MINIMUM_MATCH_SCORE = 3;
const DEFAULT_COMMIT_SHA = 'unknown';
const logger = Logger.get('HelpBotKnowledge');

const WALLET_CONTEXT_PATTERNS = [
  /\bwallets?\b/,
  /\baddresses?\b/,
  /\bvault\b/,
  /\bhot wallet\b/,
  /\bcold wallet\b/,
  /\bminting wallet\b/,
  /\btransaction wallet\b/
] as const;

const ARCHITECTURE_CONTEXT_PATTERNS = [
  /\barchitecture\b/,
  /\barchitectures\b/,
  /\btap\b/,
  /\bthree address\b/,
  /\bfour address\b/,
  /\b3 address\b/,
  /\b4 address\b/,
  /\bthree wallets?\b/,
  /\bfour wallets?\b/,
  /\b3 wallets?\b/,
  /\b4 wallets?\b/,
  /\bmultiple wallets?\b/,
  /\bseveral wallets?\b/,
  /\bvault\b/,
  /\bminting\b/,
  /\btransaction\b/
] as const;

const EXPLICIT_ARCHITECTURE_CONTEXT_PATTERNS = [
  /\barchitecture\b/,
  /\barchitectures\b/,
  /\btap\b/,
  /\bthree address\b/,
  /\bfour address\b/,
  /\b3 address\b/,
  /\b4 address\b/,
  /\bthree wallets?\b/,
  /\bfour wallets?\b/,
  /\b3 wallets?\b/,
  /\b4 wallets?\b/,
  /\bmultiple wallets?\b/,
  /\bseveral wallets?\b/
] as const;

const CONSOLIDATION_CONTEXT_PATTERNS = [
  /\bconsolidat(?:e|es|ed|ing|ion|ions)\b/,
  /\bcount(?:ed)? together\b/,
  /\btreat(?:ed)? together\b/,
  /\bconnect(?:ed|ing)? (?:my )?(?:wallets?|addresses?)\b/,
  /\bcombine(?:d|s|ing)? (?:my )?(?:wallets?|addresses?)\b/
] as const;

const WALLET_CHECK_CONTEXT_PATTERNS = [
  /\bcheck\b/,
  /\bview\b/,
  /\breview\b/,
  /\bverify\b/,
  /\binspect\b/,
  /\bsee\b/,
  /\bshow\b/
] as const;

const WALLET_ARCHITECTURE_PATH = '/delegation/wallet-architecture';
const WALLET_CHECKER_PATH = '/delegation/wallet-checker';
const CONSOLIDATION_USE_CASES_PATH = '/delegation/consolidation-use-cases';
const REGISTER_CONSOLIDATION_PATH = '/delegation/register-consolidation';
const REGISTER_CONSOLIDATION_DOC_PATH =
  '/delegation/delegation-faq/register-consolidation';

export class HelpBotKnowledgeUnavailableError extends Error {
  constructor(
    message: string,
    public readonly originalError?: unknown
  ) {
    super(message);
    this.name = 'HelpBotKnowledgeUnavailableError';
    Object.setPrototypeOf(this, HelpBotKnowledgeUnavailableError.prototype);
  }
}

async function fetchHelpIndexWithTimeout(
  url: string,
  timeoutMs: number
): Promise<HelpBotIndexResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

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

function readLinkLabel(
  raw: Record<string, unknown>,
  fallbackTitle: string
): string {
  return (
    readString(raw.linkLabel) ?? readString(raw.link_label) ?? fallbackTitle
  );
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
    linkLabel: readLinkLabel(raw, title),
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
  const tokens = new Set<string>();
  normalizeText(value)
    .split(' ')
    .filter((token) => token.length > 1 || token === '+')
    .forEach((token) => {
      tokenVariants(token).forEach((variant) => tokens.add(variant));
    });
  return tokens;
}

function tokenVariants(token: string): string[] {
  const variants = [token];
  if (token.length > 4 && token.endsWith('ies')) {
    variants.push(`${token.slice(0, -3)}y`);
  }
  if (isSafeTrailingPlural(token)) {
    variants.push(token.slice(0, -1));
  }
  return variants;
}

function isSafeTrailingPlural(token: string): boolean {
  return (
    token.length > 3 && token.endsWith('s') && !/(ss|us|is|ias)$/.test(token)
  );
}

function normalizedPhraseTokens(value: string): string[] {
  return normalizeText(value)
    .split(' ')
    .filter((token) => token.length > 0);
}

function containsNormalizedPhrase(
  normalizedQuestion: string,
  phrase: string
): boolean {
  const normalizedPhrase = normalizeText(phrase);
  if (!normalizedPhrase) {
    return false;
  }
  if (` ${normalizedQuestion} `.includes(` ${normalizedPhrase} `)) {
    return true;
  }
  const questionTokens = normalizedPhraseTokens(normalizedQuestion);
  const phraseTokens = normalizedPhraseTokens(normalizedPhrase);
  if (!phraseTokens.length || phraseTokens.length > questionTokens.length) {
    return false;
  }
  return questionTokens.some((_token, index) => {
    const candidate = questionTokens.slice(index, index + phraseTokens.length);
    return (
      candidate.length === phraseTokens.length &&
      phraseTokens.every((phraseToken, phraseIndex) =>
        tokenVariants(candidate[phraseIndex]).includes(phraseToken)
      )
    );
  });
}

function matchesAny(
  normalizedQuestion: string,
  patterns: readonly RegExp[]
): boolean {
  return patterns.some((pattern) => pattern.test(normalizedQuestion));
}

function addRoutedScore(
  scores: Map<string, number>,
  canonicalPath: string,
  score: number
): void {
  scores.set(canonicalPath, Math.max(scores.get(canonicalPath) ?? 0, score));
}

function routedRecordScores(
  normalizedQuestion: string
): ReadonlyMap<string, number> {
  const hasWalletContext = matchesAny(
    normalizedQuestion,
    WALLET_CONTEXT_PATTERNS
  );
  const hasArchitectureContext = matchesAny(
    normalizedQuestion,
    ARCHITECTURE_CONTEXT_PATTERNS
  );
  const hasExplicitArchitectureContext = matchesAny(
    normalizedQuestion,
    EXPLICIT_ARCHITECTURE_CONTEXT_PATTERNS
  );
  const hasConsolidationContext = matchesAny(
    normalizedQuestion,
    CONSOLIDATION_CONTEXT_PATTERNS
  );
  const hasWalletCheckContext = matchesAny(
    normalizedQuestion,
    WALLET_CHECK_CONTEXT_PATTERNS
  );
  const scores = new Map<string, number>();

  if (
    (hasArchitectureContext && hasWalletContext) ||
    (hasExplicitArchitectureContext && hasWalletCheckContext)
  ) {
    addRoutedScore(scores, WALLET_ARCHITECTURE_PATH, 6);
    addRoutedScore(scores, WALLET_CHECKER_PATH, hasWalletCheckContext ? 8 : 4);
  }

  if (hasConsolidationContext && (hasWalletContext || hasArchitectureContext)) {
    addRoutedScore(scores, REGISTER_CONSOLIDATION_DOC_PATH, 8);
    addRoutedScore(scores, REGISTER_CONSOLIDATION_PATH, 7);
    addRoutedScore(scores, CONSOLIDATION_USE_CASES_PATH, 5);
    addRoutedScore(scores, WALLET_ARCHITECTURE_PATH, 5);
  }

  return scores;
}

function phraseScore(question: string, record: HelpBotKnowledgeRecord): number {
  return record.aliases.reduce((score, alias) => {
    return containsNormalizedPhrase(question, alias) ? score + 3 : score;
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

function findMatchesInRecords(
  question: string,
  records: readonly HelpBotKnowledgeRecord[],
  limit: number
): HelpBotKnowledgeMatch[] {
  const normalizedQuestion = normalizeText(question);
  if (!normalizedQuestion) {
    return [];
  }
  const questionTokens = tokenize(question);
  const routedScores = routedRecordScores(normalizedQuestion);
  return records
    .map((record) => ({
      record,
      score:
        phraseScore(normalizedQuestion, record) +
        keywordScore(questionTokens, record) +
        (routedScores.get(record.canonicalPath) ?? 0)
    }))
    .filter((match) => match.score >= MINIMUM_MATCH_SCORE)
    .sort((a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id))
    .slice(0, Math.max(1, limit));
}

function findMatchInRecords(
  question: string,
  records: readonly HelpBotKnowledgeRecord[]
): HelpBotKnowledgeMatch | null {
  const matches = findMatchesInRecords(question, records, 1);
  return matches[0] ?? null;
}

export class StaticHelpBotKnowledgeSource implements HelpBotKnowledgeSource {
  constructor(private readonly index: HelpBotKnowledgeIndex) {}

  public async findMatch(
    question: string
  ): Promise<HelpBotKnowledgeMatch | null> {
    return findMatchInRecords(question, this.index.records);
  }

  public async findMatches(
    question: string,
    limit = 1
  ): Promise<HelpBotKnowledgeMatch[]> {
    return findMatchesInRecords(question, this.index.records, limit);
  }
}

export class FrontendHelpBotKnowledgeSource implements HelpBotKnowledgeSource {
  private cachedIndex: HelpBotKnowledgeIndex | null = null;
  private cacheExpiresAt = 0;

  constructor(
    private readonly fetcher: HelpBotIndexFetcher = fetchHelpIndexWithTimeout
  ) {}

  public async findMatch(
    question: string
  ): Promise<HelpBotKnowledgeMatch | null> {
    const index = await this.loadIndex();
    return index ? findMatchInRecords(question, index.records) : null;
  }

  public async findMatches(
    question: string,
    limit = 1
  ): Promise<HelpBotKnowledgeMatch[]> {
    const index = await this.loadIndex();
    return index ? findMatchesInRecords(question, index.records, limit) : [];
  }

  private async loadIndex(): Promise<HelpBotKnowledgeIndex | null> {
    const now = Date.now();
    if (now < this.cacheExpiresAt) {
      return this.cachedIndex ?? this.throwUnavailable();
    }
    try {
      const response = await this.fetcher(
        HELP_BOT_INDEX_URL,
        HELP_BOT_INDEX_FETCH_TIMEOUT_MS
      );
      if (!response.ok) {
        throw new Error(`Frontend help index returned HTTP ${response.status}`);
      }
      const index = normalizeIndex(JSON.parse(await response.text()));
      if (!index) {
        throw new Error('Frontend help index is empty or invalid');
      }
      this.cachedIndex = index;
      this.cacheExpiresAt = now + HELP_BOT_INDEX_CACHE_TTL_MS;
      return index;
    } catch (error) {
      this.cacheExpiresAt = now + Math.min(HELP_BOT_INDEX_CACHE_TTL_MS, 30_000);
      logger.warn(
        `Could not load frontend help index from ${HELP_BOT_INDEX_URL}`,
        error
      );
      return this.cachedIndex ?? this.throwUnavailable(error);
    }
  }

  private throwUnavailable(error?: unknown): never {
    throw new HelpBotKnowledgeUnavailableError(
      'Frontend help index is currently unavailable',
      error
    );
  }
}

export const frontendHelpBotKnowledgeSource =
  new FrontendHelpBotKnowledgeSource();
