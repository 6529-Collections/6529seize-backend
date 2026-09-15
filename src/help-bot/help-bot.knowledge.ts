import { Logger } from '@/logging';
import { CONSOLIDATIONS_LIMIT } from '@/constants';
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
  readonly suppressSourceLinks?: boolean;
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
  /\baddress(?:es)?\b/,
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
  /\b3 address\b/,
  /\bthree wallets?\b/,
  /\b3 wallets?\b/,
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
  /\b3 address\b/,
  /\bthree wallets?\b/,
  /\b3 wallets?\b/,
  /\bmultiple wallets?\b/,
  /\bseveral wallets?\b/
] as const;

const CONSOLIDATION_CONTEXT_PATTERNS = [
  /\bconsolidat(?:e|es|ed|ing|ion|ions)\b/,
  /\bcount(?:ed)? together\b/,
  /\btreat(?:ed)? together\b/,
  /\bcombine(?:d|s|ing)? (?:my )?(?:wallets?|address(?:es)?)\b/
] as const;

const MULTI_WALLET_SETUP_ACTION_PATTERNS = [
  /\badd(?:ing)?\b/,
  /\battach(?:ing)?\b/,
  /\bbring(?:ing)?\b/,
  /\binclud(?:e|ing)\b/,
  /\blink(?:ing)?\b/,
  /\bpair(?:ing)?\b/,
  /\bcombin(?:e|ing)\b/,
  /\bassociat(?:e|ing)\b/,
  /\bjoin(?:ing)?\b/,
  /\b(?:tie|tying)\b/,
  /\bset(?:ting)? up\b/,
  /\bsetup\b/
] as const;

const AMBIGUOUS_WALLET_CONNECTION_ACTION_PATTERNS = [
  /\bconnect(?:s|ed|ing)?\b/
] as const;

const MULTI_WALLET_REMOVAL_ACTION_PATTERNS = [
  /\bremov(?:e[ds]?|ing)\b/,
  /\bunlink(?:s|ed|ing)?\b/,
  /\bdetach(?:es|ed|ing)?\b/,
  /\bdelet(?:e[ds]?|ing)\b/,
  /\brevok(?:e[ds]?|ing)\b/,
  /\bcancel(?:s|ed|led|ing|ling)?\b/
] as const;

const MULTI_WALLET_REPLACEMENT_ACTION_PATTERNS = [
  /\breplac(?:e[ds]?|ing)\b/,
  /\bswap(?:s|ped|ping)?\b/,
  /\bchang(?:e[ds]?|ing)\b/,
  /\bupdat(?:e[ds]?|ing)\b/
] as const;

const EXTERNAL_WALLET_CONTEXT_PATTERNS = [
  /\bhardware wallets?\b/,
  /\bmetamask\b/,
  /\bcoinbase wallet\b/,
  /\brainbow wallet\b/,
  /\bledger\b/,
  /\btrezor\b/,
  /\bwallet apps?\b/,
  /\bbrowser extensions?\b/,
  /\bthis device\b/
] as const;

const EXPLICIT_ADDITIONAL_WALLET_TARGET_PATTERNS = [
  /\bsecond wallet\b/,
  /\bsecond address\b/,
  /\banother wallet\b/,
  /\banother address\b/,
  /\badditional wallet\b/,
  /\badditional address\b/,
  /\bextra wallet\b/,
  /\bextra address\b/,
  /\bnew wallet\b/,
  /\bnew address\b/,
  /\bone more wallet\b/,
  /\bone more address\b/,
  /\bother wallet\b/,
  /\bother address\b/,
  /\b2nd wallet\b/,
  /\b2nd address\b/
] as const;

const QUANTIFIED_MULTI_WALLET_TARGET_PATTERNS = [
  /\btwo wallets?\b/,
  /\btwo address(?:es)?\b/,
  /\b2 wallets?\b/,
  /\b2 address(?:es)?\b/,
  /\bmultiple wallets?\b/,
  /\bmultiple address(?:es)?\b/,
  /\b(?:several|many|more|a few) wallets?\b/,
  /\b(?:several|many|more|a few) address(?:es)?\b/
] as const;

const POSSESSIVE_MULTI_WALLET_TARGET_PATTERNS = [
  /\bmy wallets\b/,
  /\bmy addresses\b/,
  /\bthe wallets\b/,
  /\bthe addresses\b/
] as const;

const MULTI_WALLET_SETUP_TARGET_PATTERNS = [
  ...EXPLICIT_ADDITIONAL_WALLET_TARGET_PATTERNS,
  ...QUANTIFIED_MULTI_WALLET_TARGET_PATTERNS,
  ...POSSESSIVE_MULTI_WALLET_TARGET_PATTERNS
] as const;

const CONSOLIDATION_LIMIT_CONTEXT_PATTERNS = [
  /\bhow many\b/,
  /\bnumber of\b/,
  /\bmaximum\b/,
  /\bmax\b/,
  /\blimit\b/,
  /\blimits\b/,
  /\bcapacity\b/,
  /\bgroup size\b/,
  /\bone consolidation group\b/,
  /\bper consolidation group\b/,
  /\bcan be in\b/
] as const;

const STRONG_CONSOLIDATION_LIMIT_CONTEXT_PATTERNS = [
  /\bmaximum\b/,
  /\bmax\b/,
  /\blimit\b/,
  /\blimits\b/,
  /\bcapacity\b/,
  /\bgroup size\b/
] as const;

const CONSOLIDATION_COUNT_RELATION_PATTERNS = [
  /\ballow(?:ed|s|ing)?\b/,
  /\bsupport(?:ed|s|ing)?\b/,
  /\bcount(?:ed|s|ing)?\b/,
  /\brecogniz(?:e|ed|es|ing)\b/,
  /\bgroup(?:ed|s|ing)?\b/,
  /\btreat(?:ed|s|ing)?\b/
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
const MANAGE_REVOKE_DOC_PATH = '/delegation/delegation-faq/manage-revoke';
const MANAGE_UPDATE_DOC_PATH = '/delegation/delegation-faq/manage-update';
const WALLET_MANAGEMENT_CLARIFICATION_ID =
  'delegation.wallet-management-clarification';
const WALLET_ARCHITECTURE_ID = 'delegation.wallet-architecture';
const WALLET_CHECKER_ID = 'delegation.wallet-checker';
const NETWORK_DEFINITIONS_ID = 'network.definitions';
const GENESIS_SETS_ID = 'network.definitions.genesis-sets';
const MEME_SETS_ID = 'network.definitions.meme-sets';
const MEME_SETS_MINUS_ID = 'network.definitions.meme-sets-minus';
const TDH_UNWEIGHTED_ID = 'network.definitions.tdh-unweighted';
const TDH_UNBOOSTED_ID = 'network.definitions.tdh-unboosted';
const NAKAMOTO_SET_ID = 'network.tdh.nakamoto-set';
const NETWORK_TDH_ID = 'network.tdh';
const STREAM_REVIEW_ID = 'public-reviews.stream';

const WALLET_COUNT_WORDS = new Map<string, number>([
  ['one', 1],
  ['two', 2],
  ['three', 3],
  ['four', 4],
  ['five', 5],
  ['six', 6],
  ['seven', 7],
  ['eight', 8],
  ['nine', 9],
  ['ten', 10]
]);

const WALLET_COUNT_PATTERN =
  /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)[-\s]+(?:wallet|wallets|address|addresses)\b/g;

const DELEGATION_CONTEXT_PATTERNS = [
  /\bdelegat(?:e|es|ed|ing|ion|ions)\b/,
  /\bdelegation managers?\b/,
  /\bminting delegation\b/
] as const;

const DISQUALIFYING_DELEGATION_CONTEXT_PATTERNS = [
  /\bdelegat(?:e|es|ed|ing)\b/,
  /\bdelegations?\b(?!\s+(?:center|docs?|faq|guides?|help)\b)/
] as const;

const GENESIS_SET_PATTERNS = [/\bgenesis sets?\b/] as const;

const NAKAMOTO_SET_PATTERNS = [/\bnakamoto sets?\b/] as const;

const MEME_SET_MINUS_PATTERNS = [
  /\bmeme sets?\s*(?:-|minus)\s*(?:1|one|2|two)\b/,
  /\bsets?\s+missing\s+(?:1|one|2|two)\s+cards?\b/
] as const;

const MEME_SET_PATTERNS = [
  /\bmeme sets?\b/,
  /\bcomplete meme sets?\b/,
  /\bseason sets?\b/
] as const;

const TDH_UNWEIGHTED_PATTERNS = [
  /\btdh\s+unweighted\b/,
  /\bunweighted\s+tdh\b/,
  /\braw\s+tdh\b/,
  /\btdh__raw\b/
] as const;

const TDH_UNBOOSTED_PATTERNS = [
  /\btdh\s+unboosted\b/,
  /\bunboosted\s+tdh\b/,
  /\bweighted\s+tdh\b/,
  /\bedition weighted\s+tdh\b/
] as const;

function routedIdKey(id: string): string {
  return `id:${id}`;
}

function routedPathKey(path: string): string {
  return `path:${path}`;
}

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

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
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
    suppressSourceLinks:
      readBoolean(raw.suppressSourceLinks) ??
      readBoolean(raw.suppress_source_links) ??
      false,
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

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(value);
  }
  return unique;
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

function parseWalletCount(rawCount: string): number | null {
  const wordValue = WALLET_COUNT_WORDS.get(rawCount);
  if (wordValue !== undefined) {
    return wordValue;
  }
  const parsed = Number.parseInt(rawCount, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function hasCountedMultiWalletTarget(normalizedQuestion: string): boolean {
  WALLET_COUNT_PATTERN.lastIndex = 0;
  for (
    let match = WALLET_COUNT_PATTERN.exec(normalizedQuestion);
    match;
    match = WALLET_COUNT_PATTERN.exec(normalizedQuestion)
  ) {
    const rawCount = match[1];
    if (rawCount && (parseWalletCount(rawCount) ?? 0) >= 2) {
      return true;
    }
  }
  return false;
}

function hasMultiWalletTarget(normalizedQuestion: string): boolean {
  return (
    matchesAny(normalizedQuestion, MULTI_WALLET_SETUP_TARGET_PATTERNS) ||
    hasCountedMultiWalletTarget(normalizedQuestion)
  );
}

function hasDisqualifyingWalletContext(normalizedQuestion: string): boolean {
  return (
    matchesAny(normalizedQuestion, DISQUALIFYING_DELEGATION_CONTEXT_PATTERNS) ||
    matchesAny(normalizedQuestion, EXTERNAL_WALLET_CONTEXT_PATTERNS)
  );
}

export function isMultiWalletSetupQuestion(question: string): boolean {
  const normalizedQuestion = normalizeText(question);
  return (
    !hasDisqualifyingWalletContext(normalizedQuestion) &&
    matchesAny(normalizedQuestion, MULTI_WALLET_SETUP_ACTION_PATTERNS) &&
    hasMultiWalletTarget(normalizedQuestion)
  );
}

export function isMultiWalletLimitQuestion(question: string): boolean {
  const normalizedQuestion = normalizeText(question);
  const hasConsolidationContext = matchesAny(
    normalizedQuestion,
    CONSOLIDATION_CONTEXT_PATTERNS
  );
  const hasLimitContext = matchesAny(
    normalizedQuestion,
    CONSOLIDATION_LIMIT_CONTEXT_PATTERNS
  );
  const hasLimitRelation =
    hasConsolidationContext ||
    matchesAny(normalizedQuestion, MULTI_WALLET_SETUP_ACTION_PATTERNS) ||
    matchesAny(normalizedQuestion, CONSOLIDATION_COUNT_RELATION_PATTERNS);
  return (
    matchesAny(normalizedQuestion, WALLET_CONTEXT_PATTERNS) &&
    !hasDisqualifyingWalletContext(normalizedQuestion) &&
    (matchesAny(
      normalizedQuestion,
      STRONG_CONSOLIDATION_LIMIT_CONTEXT_PATTERNS
    ) ||
      (hasLimitContext && hasLimitRelation))
  );
}

export function isMultiWalletRemovalQuestion(question: string): boolean {
  const normalizedQuestion = normalizeText(question);
  const hasConsolidationContext = matchesAny(
    normalizedQuestion,
    CONSOLIDATION_CONTEXT_PATTERNS
  );
  return (
    matchesAny(normalizedQuestion, WALLET_CONTEXT_PATTERNS) &&
    matchesAny(normalizedQuestion, MULTI_WALLET_REMOVAL_ACTION_PATTERNS) &&
    (hasConsolidationContext || hasMultiWalletTarget(normalizedQuestion)) &&
    !hasDisqualifyingWalletContext(normalizedQuestion)
  );
}

export function isMultiWalletReplacementQuestion(question: string): boolean {
  const normalizedQuestion = normalizeText(question);
  const hasConsolidationContext = matchesAny(
    normalizedQuestion,
    CONSOLIDATION_CONTEXT_PATTERNS
  );
  return (
    matchesAny(normalizedQuestion, WALLET_CONTEXT_PATTERNS) &&
    matchesAny(normalizedQuestion, MULTI_WALLET_REPLACEMENT_ACTION_PATTERNS) &&
    (hasConsolidationContext || hasMultiWalletTarget(normalizedQuestion)) &&
    !hasDisqualifyingWalletContext(normalizedQuestion)
  );
}

export function isAmbiguousWalletManagementQuestion(question: string): boolean {
  const normalizedQuestion = normalizeText(question);
  const hasRemovalOrReplacementAction =
    matchesAny(normalizedQuestion, MULTI_WALLET_REMOVAL_ACTION_PATTERNS) ||
    matchesAny(normalizedQuestion, MULTI_WALLET_REPLACEMENT_ACTION_PATTERNS);
  const hasAmbiguousConnectionAction =
    matchesAny(
      normalizedQuestion,
      AMBIGUOUS_WALLET_CONNECTION_ACTION_PATTERNS
    ) &&
    (hasMultiWalletTarget(normalizedQuestion) ||
      matchesAny(normalizedQuestion, CONSOLIDATION_LIMIT_CONTEXT_PATTERNS));
  const hasAmbiguousManagementAction =
    (hasRemovalOrReplacementAction &&
      !hasMultiWalletTarget(normalizedQuestion)) ||
    hasAmbiguousConnectionAction;
  return (
    hasAmbiguousManagementAction &&
    matchesAny(normalizedQuestion, WALLET_CONTEXT_PATTERNS) &&
    !matchesAny(normalizedQuestion, CONSOLIDATION_CONTEXT_PATTERNS) &&
    !hasDisqualifyingWalletContext(normalizedQuestion) &&
    !/\bprofiles?\b/.test(normalizedQuestion)
  );
}

function requestedOverLimitWalletCount(
  normalizedQuestion: string
): number | null {
  WALLET_COUNT_PATTERN.lastIndex = 0;
  let overLimitCount: number | null = null;
  for (
    let match = WALLET_COUNT_PATTERN.exec(normalizedQuestion);
    match;
    match = WALLET_COUNT_PATTERN.exec(normalizedQuestion)
  ) {
    const rawCount = match[1];
    if (!rawCount) {
      continue;
    }
    const count = parseWalletCount(rawCount);
    if (count !== null && count > CONSOLIDATIONS_LIMIT) {
      overLimitCount = Math.max(overLimitCount ?? count, count);
    }
  }
  return overLimitCount;
}

function addRoutedScore(
  scores: Map<string, number>,
  key: string,
  score: number
): void {
  scores.set(key, Math.max(scores.get(key) ?? 0, score));
}

function addRoutedIdScore(
  scores: Map<string, number>,
  id: string,
  score: number
): void {
  addRoutedScore(scores, routedIdKey(id), score);
}

function addRoutedPathScore(
  scores: Map<string, number>,
  canonicalPath: string,
  score: number
): void {
  addRoutedScore(scores, routedPathKey(canonicalPath), score);
}

interface RoutedQuestionContext {
  readonly normalizedQuestion: string;
  readonly hasWalletContext: boolean;
  readonly hasArchitectureContext: boolean;
  readonly hasExplicitArchitectureContext: boolean;
  readonly hasConsolidationContext: boolean;
  readonly hasMultiWalletSetupContext: boolean;
  readonly hasMultiWalletLimitContext: boolean;
  readonly hasMultiWalletRemovalContext: boolean;
  readonly hasMultiWalletReplacementContext: boolean;
  readonly hasAmbiguousWalletManagementContext: boolean;
  readonly hasConsolidationLimitContext: boolean;
  readonly hasDelegationContext: boolean;
  readonly hasWalletCheckContext: boolean;
  readonly overLimitWalletCount: number | null;
}

function routedQuestionContext(
  normalizedQuestion: string
): RoutedQuestionContext {
  return {
    normalizedQuestion,
    hasWalletContext: matchesAny(normalizedQuestion, WALLET_CONTEXT_PATTERNS),
    hasArchitectureContext: matchesAny(
      normalizedQuestion,
      ARCHITECTURE_CONTEXT_PATTERNS
    ),
    hasExplicitArchitectureContext: matchesAny(
      normalizedQuestion,
      EXPLICIT_ARCHITECTURE_CONTEXT_PATTERNS
    ),
    hasConsolidationContext: matchesAny(
      normalizedQuestion,
      CONSOLIDATION_CONTEXT_PATTERNS
    ),
    hasMultiWalletSetupContext: isMultiWalletSetupQuestion(normalizedQuestion),
    hasMultiWalletLimitContext: isMultiWalletLimitQuestion(normalizedQuestion),
    hasMultiWalletRemovalContext:
      isMultiWalletRemovalQuestion(normalizedQuestion),
    hasMultiWalletReplacementContext:
      isMultiWalletReplacementQuestion(normalizedQuestion),
    hasAmbiguousWalletManagementContext:
      isAmbiguousWalletManagementQuestion(normalizedQuestion),
    hasConsolidationLimitContext: matchesAny(
      normalizedQuestion,
      CONSOLIDATION_LIMIT_CONTEXT_PATTERNS
    ),
    hasDelegationContext: matchesAny(
      normalizedQuestion,
      DELEGATION_CONTEXT_PATTERNS
    ),
    hasWalletCheckContext: matchesAny(
      normalizedQuestion,
      WALLET_CHECK_CONTEXT_PATTERNS
    ),
    overLimitWalletCount: requestedOverLimitWalletCount(normalizedQuestion)
  };
}

function addOverLimitWalletScores(
  scores: Map<string, number>,
  context: RoutedQuestionContext
): void {
  if (context.overLimitWalletCount !== null) {
    addRoutedPathScore(scores, CONSOLIDATION_USE_CASES_PATH, 16);
    addRoutedIdScore(scores, WALLET_ARCHITECTURE_ID, 8);
    addRoutedPathScore(scores, WALLET_ARCHITECTURE_PATH, 5);
    addRoutedPathScore(scores, REGISTER_CONSOLIDATION_DOC_PATH, 5);
  }
}

function addArchitectureScores(
  scores: Map<string, number>,
  context: RoutedQuestionContext
): void {
  if (context.hasExplicitArchitectureContext) {
    addRoutedIdScore(scores, WALLET_ARCHITECTURE_ID, 8);
    addRoutedPathScore(scores, WALLET_ARCHITECTURE_PATH, 4);
  }

  if (
    (context.hasArchitectureContext && context.hasWalletContext) ||
    (context.hasExplicitArchitectureContext && context.hasWalletCheckContext)
  ) {
    addRoutedIdScore(scores, WALLET_ARCHITECTURE_ID, 8);
    addRoutedPathScore(scores, WALLET_ARCHITECTURE_PATH, 5);
    addRoutedIdScore(
      scores,
      WALLET_CHECKER_ID,
      context.hasWalletCheckContext ? 10 : 4
    );
    addRoutedPathScore(
      scores,
      WALLET_CHECKER_PATH,
      context.hasWalletCheckContext ? 7 : 3
    );
  }
}

function addWalletCheckerScores(
  scores: Map<string, number>,
  context: RoutedQuestionContext
): void {
  if (
    context.hasWalletCheckContext &&
    (context.hasDelegationContext || context.hasConsolidationContext)
  ) {
    addRoutedIdScore(scores, WALLET_CHECKER_ID, 10);
    addRoutedPathScore(scores, WALLET_CHECKER_PATH, 7);
  }
}

function addConsolidationManagementScores(
  scores: Map<string, number>,
  context: RoutedQuestionContext
): void {
  if (context.hasMultiWalletRemovalContext) {
    addRoutedPathScore(scores, MANAGE_REVOKE_DOC_PATH, 18);
    addRoutedPathScore(scores, REGISTER_CONSOLIDATION_DOC_PATH, 5);
    addRoutedIdScore(scores, WALLET_CHECKER_ID, 4);
  }
  if (context.hasMultiWalletReplacementContext) {
    addRoutedPathScore(scores, MANAGE_UPDATE_DOC_PATH, 18);
    addRoutedPathScore(scores, MANAGE_REVOKE_DOC_PATH, 6);
    addRoutedPathScore(scores, REGISTER_CONSOLIDATION_DOC_PATH, 5);
  }
  if (context.hasAmbiguousWalletManagementContext) {
    addRoutedIdScore(scores, WALLET_MANAGEMENT_CLARIFICATION_ID, 18);
  }
}

function applyConsolidationRoutingExclusions(
  scores: Map<string, number>,
  context: RoutedQuestionContext
): void {
  if (!hasDisqualifyingWalletContext(context.normalizedQuestion)) {
    return;
  }

  [
    CONSOLIDATION_USE_CASES_PATH,
    REGISTER_CONSOLIDATION_PATH,
    REGISTER_CONSOLIDATION_DOC_PATH,
    MANAGE_REVOKE_DOC_PATH,
    MANAGE_UPDATE_DOC_PATH
  ].forEach((path) => scores.set(routedPathKey(path), -100));
  scores.set(routedIdKey(WALLET_MANAGEMENT_CLARIFICATION_ID), -100);
}

function addConsolidationScores(
  scores: Map<string, number>,
  context: RoutedQuestionContext
): void {
  if (
    (context.hasMultiWalletLimitContext ||
      (context.hasConsolidationContext &&
        context.hasConsolidationLimitContext)) &&
    (context.hasWalletContext || context.hasArchitectureContext)
  ) {
    addRoutedPathScore(scores, CONSOLIDATION_USE_CASES_PATH, 18);
    addRoutedIdScore(scores, WALLET_ARCHITECTURE_ID, 8);
    addRoutedPathScore(scores, WALLET_ARCHITECTURE_PATH, 6);
    addRoutedPathScore(scores, REGISTER_CONSOLIDATION_DOC_PATH, 5);
    return;
  }

  if (
    (context.hasConsolidationContext || context.hasMultiWalletSetupContext) &&
    (context.hasWalletContext || context.hasArchitectureContext)
  ) {
    addRoutedPathScore(scores, REGISTER_CONSOLIDATION_DOC_PATH, 16);
    addRoutedPathScore(scores, REGISTER_CONSOLIDATION_PATH, 15);
    addRoutedPathScore(scores, CONSOLIDATION_USE_CASES_PATH, 9);
    addRoutedIdScore(scores, WALLET_ARCHITECTURE_ID, 5);
    addRoutedPathScore(scores, WALLET_ARCHITECTURE_PATH, 4);
  }
}

function addNetworkDefinitionScores(
  scores: Map<string, number>,
  context: RoutedQuestionContext
): void {
  if (matchesAny(context.normalizedQuestion, GENESIS_SET_PATTERNS)) {
    addRoutedIdScore(scores, GENESIS_SETS_ID, 12);
    addRoutedIdScore(scores, NETWORK_DEFINITIONS_ID, 4);
    addRoutedIdScore(scores, NETWORK_TDH_ID, 3);
  }

  if (matchesAny(context.normalizedQuestion, NAKAMOTO_SET_PATTERNS)) {
    addRoutedIdScore(scores, NAKAMOTO_SET_ID, 12);
    addRoutedIdScore(scores, NETWORK_TDH_ID, 4);
  }

  if (matchesAny(context.normalizedQuestion, MEME_SET_MINUS_PATTERNS)) {
    addRoutedIdScore(scores, MEME_SETS_MINUS_ID, 12);
    addRoutedIdScore(scores, MEME_SETS_ID, 4);
    addRoutedIdScore(scores, NETWORK_DEFINITIONS_ID, 3);
  } else if (matchesAny(context.normalizedQuestion, MEME_SET_PATTERNS)) {
    addRoutedIdScore(scores, MEME_SETS_ID, 12);
    addRoutedIdScore(scores, NETWORK_DEFINITIONS_ID, 3);
  }
}

function addTdhDefinitionScores(
  scores: Map<string, number>,
  context: RoutedQuestionContext
): void {
  if (matchesAny(context.normalizedQuestion, TDH_UNWEIGHTED_PATTERNS)) {
    addRoutedIdScore(scores, TDH_UNWEIGHTED_ID, 12);
    addRoutedIdScore(scores, NETWORK_TDH_ID, 4);
  }

  if (matchesAny(context.normalizedQuestion, TDH_UNBOOSTED_PATTERNS)) {
    addRoutedIdScore(scores, TDH_UNBOOSTED_ID, 12);
    addRoutedIdScore(scores, NETWORK_TDH_ID, 4);
  }
}

function addStreamReviewScores(
  scores: Map<string, number>,
  context: RoutedQuestionContext
): void {
  if (/\b(?:6529 )?stream\b/.test(context.normalizedQuestion)) {
    addRoutedIdScore(scores, STREAM_REVIEW_ID, 20);
  }
}

function routedRecordScores(
  normalizedQuestion: string
): ReadonlyMap<string, number> {
  const context = routedQuestionContext(normalizedQuestion);
  const scores = new Map<string, number>();

  addOverLimitWalletScores(scores, context);
  addArchitectureScores(scores, context);
  addWalletCheckerScores(scores, context);
  addConsolidationManagementScores(scores, context);
  addConsolidationScores(scores, context);
  addNetworkDefinitionScores(scores, context);
  addTdhDefinitionScores(scores, context);
  addStreamReviewScores(scores, context);
  applyConsolidationRoutingExclusions(scores, context);

  return scores;
}

function phraseScore(question: string, record: HelpBotKnowledgeRecord): number {
  return uniqueStrings([record.title, ...record.aliases]).reduce(
    (score, alias) => {
      return containsNormalizedPhrase(question, alias) ? score + 3 : score;
    },
    0
  );
}

function keywordMatches(questionTokens: Set<string>, keyword: string): boolean {
  const normalizedKeyword = normalizeText(keyword);
  if (!normalizedKeyword) {
    return false;
  }
  if (questionTokens.has(normalizedKeyword)) {
    return true;
  }
  const keywordTokens = normalizedPhraseTokens(normalizedKeyword);
  return (
    keywordTokens.length === 1 &&
    tokenVariants(keywordTokens[0]).some((variant) =>
      questionTokens.has(variant)
    )
  );
}

function keywordScore(
  questionTokens: Set<string>,
  record: HelpBotKnowledgeRecord
): number {
  return uniqueStrings([...record.keywords, ...record.tags]).reduce(
    (score, keyword) => {
      return keywordMatches(questionTokens, keyword) ? score + 1 : score;
    },
    0
  );
}

function routedScore(
  routedScores: ReadonlyMap<string, number>,
  record: HelpBotKnowledgeRecord
): number {
  return (
    (routedScores.get(routedIdKey(record.id)) ?? 0) +
    (routedScores.get(routedPathKey(record.canonicalPath)) ?? 0)
  );
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
        routedScore(routedScores, record)
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
