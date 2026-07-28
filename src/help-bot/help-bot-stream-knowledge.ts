import { createHash } from 'node:crypto';
import { Logger } from '@/logging';
import {
  HELP_BOT_BASE_URL,
  HELP_BOT_INDEX_CACHE_TTL_MS,
  HELP_BOT_INDEX_FETCH_TIMEOUT_MS
} from './help-bot.config';
import {
  HelpBotKnowledgeMatch,
  HelpBotKnowledgeRecord
} from './help-bot.knowledge';

const REVIEW_ID = '6529-stream';
const REVIEW_INDEX_PATH = `/review-data/${REVIEW_ID}/index.json`;
const MANIFEST_SCHEMA = 'public-review.knowledge-manifest.v1';
const INDEX_SCHEMA = 'public-review.knowledge-index.v1';
const SHARD_SCHEMA = 'public-review.knowledge-shard.v1';
const REFERENCE_INDEX_SCHEMA = 'public-review.solidity-reference-index.v1';
const PUBLIC_LIFECYCLE_STATES = new Set([
  'SCHEDULED',
  'PUBLIC_REVIEW',
  'REVIEW_CLOSED',
  'REMEDIATION',
  'AUDIT',
  'FINAL_CANDIDATE',
  'DEPLOYED',
  'ARCHIVED'
]);
const DEPLOYMENT_STATES = new Set(['NOT_DEPLOYED', 'DEPLOYED']);
const AUDIT_STATES = new Set([
  'PRE_AUDIT',
  'AUDIT_IN_PROGRESS',
  'AUDIT_COMPLETE'
]);
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const VERSION_PATTERN = /^\d{4}-\d{2}-\d{2}\.\d+$/;
const MAX_MANIFEST_CHARACTERS = 256_000;
const MAX_SEARCH_INDEX_CHARACTERS = 8_000_000;
const MAX_SHARD_CHARACTERS = 1_000_000;
const MAX_CATALOG_RECORDS = 12_000;
const MAX_RECORD_SHARDS = 128;
const MAX_RECORDS_PER_SHARD = 200;
const MIN_EVIDENCE_RECORDS = 4;
const MAX_EVIDENCE_RECORDS = 10;
const MAX_EVIDENCE_PACKET_CHARACTERS = 10_000;
const MAX_EVIDENCE_RECORD_CHARACTERS = 2_300;
const MAX_EVIDENCE_METADATA_CHARACTERS =
  MAX_EVIDENCE_PACKET_CHARACTERS -
  MIN_EVIDENCE_RECORDS * MAX_EVIDENCE_RECORD_CHARACTERS;
const MAX_INITIAL_CANDIDATES = 8;
const UNAVAILABLE_RETRY_TTL_MS = 30_000;

interface StreamFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly text: string;
}

export type StreamKnowledgeFetcher = (
  url: string,
  timeoutMs: number
) => Promise<StreamFetchResponse>;

interface ReferenceVersion {
  readonly version: string;
  readonly commit: string;
  readonly tree: string;
  readonly bundlePath: string;
  readonly bundleSha256: string;
}

interface StreamKnowledgeShardManifest {
  readonly path: string;
  readonly sha256: string;
  readonly recordCount: number;
}

interface StreamKnowledgeManifest {
  readonly schemaVersion: typeof MANIFEST_SCHEMA;
  readonly reviewId: typeof REVIEW_ID;
  readonly reviewVersion: string;
  readonly source: {
    readonly repository: string;
    readonly commit: string;
    readonly tree: string;
  };
  readonly publication: {
    readonly lifecycleState: string;
    readonly deploymentStatus: string;
    readonly auditStatus: string;
  };
  readonly reference: {
    readonly manifestPath: string;
    readonly manifestSha256: string;
    readonly bundleSha256: string;
  };
  readonly generator: {
    readonly name: string;
    readonly version: string;
    readonly sourceSha256: string;
  };
  readonly searchIndex: {
    readonly path: string;
    readonly sha256: string;
    readonly recordCount: number;
  };
  readonly recordShards: readonly StreamKnowledgeShardManifest[];
  readonly counts: {
    readonly total: number;
  };
  readonly knowledgeSha256: string;
}

interface StreamCatalogRecord {
  readonly id: string;
  readonly category: 'editorial' | 'status' | 'technical';
  readonly kind: string;
  readonly title: string;
  readonly name?: string;
  readonly signature?: string;
  readonly selector?: string;
  readonly topic0?: string;
  readonly aliases: readonly string[];
  readonly sourcePath?: string;
  readonly scope?: 'protocol' | 'script' | 'test';
  readonly classification?: string;
  readonly definitionName?: string;
  readonly searchText?: string;
  readonly recordShard: number;
}

interface StreamEvidenceRecord extends Record<string, unknown> {
  readonly id: string;
  readonly category: string;
  readonly kind: string;
  readonly title: string;
  readonly canonicalPath: string;
  readonly summary?: string;
  readonly text?: string;
  readonly sourceLink?: string;
  readonly bodyExcerpt?: string;
  readonly relationships?: {
    readonly relatedDefinitionId?: string;
    readonly relatedEditorialIds?: readonly string[];
  };
}

interface LoadedCorpus {
  readonly cacheKey: string;
  readonly manifest: StreamKnowledgeManifest;
  readonly catalog: readonly StreamCatalogRecord[];
  readonly byId: ReadonlyMap<string, StreamCatalogRecord>;
  readonly exactLookup: ReadonlyMap<string, readonly StreamCatalogRecord[]>;
}

interface RankedCatalogRecord {
  readonly record: StreamCatalogRecord;
  readonly score: number;
  readonly exact: boolean;
}

interface QueryContext {
  readonly normalizedQuestion: string;
  readonly splitQuestion: string;
  readonly queryTokens: ReadonlySet<string>;
}

interface QueryIntent {
  readonly shouldTry: boolean;
  readonly explicitlyStreamScoped: boolean;
  readonly broadStreamQuestion: boolean;
  readonly contextualFollowUp: boolean;
}

interface EvidenceSelection {
  readonly records: readonly StreamEvidenceRecord[];
  readonly primary: StreamEvidenceRecord;
  readonly score: number;
  readonly ambiguity: string | null;
}

export interface HelpBotStreamKnowledgeSource {
  findMatch(
    question: string,
    previousBotAnswer?: string | null
  ): Promise<HelpBotKnowledgeMatch | null>;
}

async function fetchWithTimeout(
  url: string,
  timeoutMs: number
): Promise<StreamFetchResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      text
    };
  } finally {
    clearTimeout(timeout);
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .map((entry) => readString(entry))
        .filter((entry): entry is string => entry !== null)
    : [];
}

function readInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) ? (value as number) : null;
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function compareCodeUnits(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort(compareCodeUnits)
        .map((key) => [
          key,
          canonicalize((value as Record<string, unknown>)[key])
        ])
    );
  }
  return value;
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

function knowledgeIdentity(manifest: Record<string, unknown>): string {
  const clone = { ...manifest };
  delete clone.knowledgeSha256;
  return sha256(stableJson(clone));
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256_PATTERN.test(value);
}

function safePublishedPath(
  value: unknown,
  expectedPrefix: string
): string | null {
  const publishedPath = readString(value);
  if (
    !publishedPath ||
    !publishedPath.startsWith(`${expectedPrefix}/`) ||
    publishedPath.includes('\\') ||
    publishedPath.split('/').some((segment) => segment === '..')
  ) {
    return null;
  }
  return publishedPath;
}

function parseReferenceVersion(value: unknown): ReferenceVersion | null {
  const raw = asObject(value);
  const version = readString(raw?.version);
  const commit = readString(raw?.commit);
  const tree = readString(raw?.tree);
  const bundlePath = readString(raw?.bundlePath);
  const bundleSha256 = readString(raw?.bundleSha256);
  if (
    !version ||
    !VERSION_PATTERN.test(version) ||
    !commit ||
    !COMMIT_PATTERN.test(commit) ||
    !tree ||
    !COMMIT_PATTERN.test(tree) ||
    !bundlePath ||
    bundlePath !==
      `/review-data/${REVIEW_ID}/versions/${version}/reference-manifest.json` ||
    !bundleSha256 ||
    !SHA256_PATTERN.test(bundleSha256)
  ) {
    return null;
  }
  return { version, commit, tree, bundlePath, bundleSha256 };
}

function parseActiveReferenceVersion(value: unknown): ReferenceVersion | null {
  const raw = asObject(value);
  const activeVersion = readString(raw?.activeVersion);
  if (
    raw?.schemaVersion !== REFERENCE_INDEX_SCHEMA ||
    raw.reviewId !== REVIEW_ID ||
    !activeVersion ||
    !Array.isArray(raw.versions)
  ) {
    return null;
  }
  const versions = raw.versions
    .map(parseReferenceVersion)
    .filter((entry): entry is ReferenceVersion => entry !== null);
  if (versions.length !== raw.versions.length) {
    return null;
  }
  return versions.find((entry) => entry.version === activeVersion) ?? null;
}

function parseManifest(
  value: unknown,
  projected: ReferenceVersion
): StreamKnowledgeManifest | null {
  const raw = asObject(value);
  const source = asObject(raw?.source);
  const publication = asObject(raw?.publication);
  const reference = asObject(raw?.reference);
  const generator = asObject(raw?.generator);
  const searchIndex = asObject(raw?.searchIndex);
  const counts = asObject(raw?.counts);
  const expectedPrefix = `/review-data/${REVIEW_ID}/versions/${projected.version}/knowledge`;
  const manifestPath = readString(reference?.manifestPath);
  const referenceManifestSha256 = readString(reference?.manifestSha256);
  const referenceBundleSha256 = readString(reference?.bundleSha256);
  const lifecycleState = readString(publication?.lifecycleState);
  const deploymentStatus = readString(publication?.deploymentStatus);
  const auditStatus = readString(publication?.auditStatus);
  const searchPath = safePublishedPath(searchIndex?.path, expectedPrefix);
  const searchSha256 = readString(searchIndex?.sha256);
  const recordCount = readInteger(searchIndex?.recordCount);
  const total = readInteger(counts?.total);
  const knowledgeSha256 = readString(raw?.knowledgeSha256);
  if (
    raw?.schemaVersion !== MANIFEST_SCHEMA ||
    raw.reviewId !== REVIEW_ID ||
    raw.reviewVersion !== projected.version ||
    source?.commit !== projected.commit ||
    source.tree !== projected.tree ||
    !readString(source?.repository) ||
    !lifecycleState ||
    !PUBLIC_LIFECYCLE_STATES.has(lifecycleState) ||
    !deploymentStatus ||
    !DEPLOYMENT_STATES.has(deploymentStatus) ||
    !auditStatus ||
    !AUDIT_STATES.has(auditStatus) ||
    manifestPath !== projected.bundlePath ||
    !referenceManifestSha256 ||
    !SHA256_PATTERN.test(referenceManifestSha256) ||
    referenceBundleSha256 !== projected.bundleSha256 ||
    !readString(generator?.name) ||
    !readString(generator?.version) ||
    !isSha256(generator?.sourceSha256) ||
    !searchPath ||
    !searchSha256 ||
    !SHA256_PATTERN.test(searchSha256) ||
    recordCount === null ||
    recordCount <= 0 ||
    recordCount > MAX_CATALOG_RECORDS ||
    total !== recordCount ||
    !knowledgeSha256 ||
    !SHA256_PATTERN.test(knowledgeSha256) ||
    !Array.isArray(raw.recordShards) ||
    raw.recordShards.length === 0 ||
    raw.recordShards.length > MAX_RECORD_SHARDS
  ) {
    return null;
  }
  const recordShards = raw.recordShards.map((entry, index) => {
    const shard = asObject(entry);
    const path = safePublishedPath(shard?.path, `${expectedPrefix}/records`);
    const checksum = readString(shard?.sha256);
    const shardRecordCount = readInteger(shard?.recordCount);
    if (
      !path ||
      path !==
        `${expectedPrefix}/records/${String(index).padStart(3, '0')}.json` ||
      !checksum ||
      !SHA256_PATTERN.test(checksum) ||
      shardRecordCount === null ||
      shardRecordCount <= 0 ||
      shardRecordCount > MAX_RECORDS_PER_SHARD
    ) {
      return null;
    }
    return {
      path,
      sha256: checksum,
      recordCount: shardRecordCount
    };
  });
  if (
    recordShards.some((entry) => entry === null) ||
    recordShards.reduce((sum, entry) => sum + (entry?.recordCount ?? 0), 0) !==
      recordCount ||
    knowledgeIdentity(raw as Record<string, unknown>) !== knowledgeSha256
  ) {
    return null;
  }
  return raw as unknown as StreamKnowledgeManifest;
}

function parseCatalogRecord(
  value: unknown,
  manifest: StreamKnowledgeManifest
): StreamCatalogRecord | null {
  const raw = asObject(value);
  const id = readString(raw?.id);
  const category = readString(raw?.category);
  const kind = readString(raw?.kind);
  const title = readString(raw?.title);
  const recordShard = readInteger(raw?.recordShard);
  if (
    !id ||
    !category ||
    !['editorial', 'status', 'technical'].includes(category) ||
    !kind ||
    !title ||
    recordShard === null ||
    recordShard < 0 ||
    recordShard >= manifest.recordShards.length
  ) {
    return null;
  }
  const scope = readString(raw?.scope);
  if (scope && !['protocol', 'script', 'test'].includes(scope)) {
    return null;
  }
  return {
    id,
    category: category as StreamCatalogRecord['category'],
    kind,
    title,
    name: readString(raw?.name) ?? undefined,
    signature: readString(raw?.signature) ?? undefined,
    selector: readString(raw?.selector) ?? undefined,
    topic0: readString(raw?.topic0) ?? undefined,
    aliases: readStringArray(raw?.aliases),
    sourcePath: readString(raw?.sourcePath) ?? undefined,
    scope: scope as StreamCatalogRecord['scope'] | undefined,
    classification: readString(raw?.classification) ?? undefined,
    definitionName: readString(raw?.definitionName) ?? undefined,
    searchText: readString(raw?.searchText) ?? undefined,
    recordShard
  };
}

function parseCatalog(
  value: unknown,
  manifest: StreamKnowledgeManifest
): StreamCatalogRecord[] | null {
  const raw = asObject(value);
  const source = asObject(raw?.source);
  if (
    raw?.schemaVersion !== INDEX_SCHEMA ||
    raw.reviewId !== REVIEW_ID ||
    raw.reviewVersion !== manifest.reviewVersion ||
    source?.repository !== manifest.source.repository ||
    source.commit !== manifest.source.commit ||
    source.tree !== manifest.source.tree ||
    raw.referenceBundleSha256 !== manifest.reference.bundleSha256 ||
    !Array.isArray(raw.records) ||
    raw.records.length !== manifest.searchIndex.recordCount
  ) {
    return null;
  }
  const records = raw.records.map((entry) =>
    parseCatalogRecord(entry, manifest)
  );
  if (records.some((entry) => entry === null)) {
    return null;
  }
  const normalized = records as StreamCatalogRecord[];
  if (
    new Set(normalized.map((record) => record.id)).size !== normalized.length
  ) {
    return null;
  }
  const perShard = new Map<number, number>();
  for (const record of normalized) {
    perShard.set(
      record.recordShard,
      (perShard.get(record.recordShard) ?? 0) + 1
    );
  }
  if (
    manifest.recordShards.some(
      (shard, index) => perShard.get(index) !== shard.recordCount
    )
  ) {
    return null;
  }
  return normalized;
}

function parseEvidenceShard(
  value: unknown,
  manifest: StreamKnowledgeManifest,
  shardNumber: number
): StreamEvidenceRecord[] | null {
  const raw = asObject(value);
  const expected = manifest.recordShards[shardNumber];
  if (
    raw?.schemaVersion !== SHARD_SCHEMA ||
    raw.reviewId !== REVIEW_ID ||
    raw.reviewVersion !== manifest.reviewVersion ||
    raw.shard !== shardNumber ||
    !Array.isArray(raw.records) ||
    raw.records.length !== expected?.recordCount
  ) {
    return null;
  }
  const records = raw.records.map((entry) => {
    const record = asObject(entry);
    const id = readString(record?.id);
    const category = readString(record?.category);
    const kind = readString(record?.kind);
    const title = readString(record?.title);
    const canonicalPath = readString(record?.canonicalPath);
    if (
      !record ||
      !id ||
      !category ||
      !kind ||
      !title ||
      !canonicalPath?.startsWith(`/reviews/${REVIEW_ID}/`)
    ) {
      return null;
    }
    return record as StreamEvidenceRecord;
  });
  return records.some((record) => record === null)
    ? null
    : (records as StreamEvidenceRecord[]);
}

function normalizeExact(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/ ?([().,:#/]) ?/g, '$1');
}

function isAsciiAlphaNumeric(character: string | undefined): boolean {
  if (!character) {
    return false;
  }
  const code = character.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122)
  );
}

function containsNormalizedTerm(haystack: string, needle: string): boolean {
  if (!needle) {
    return false;
  }
  let offset = haystack.indexOf(needle);
  while (offset >= 0) {
    const before = haystack[offset - 1];
    const after = haystack[offset + needle.length];
    if (!isAsciiAlphaNumeric(before) && !isAsciiAlphaNumeric(after)) {
      return true;
    }
    offset = haystack.indexOf(needle, offset + 1);
  }
  return false;
}

function splitAcronymBoundary(value: string): string {
  let result = '';
  for (let index = 0; index < value.length; index += 1) {
    const previous = value[index - 1];
    const current = value[index];
    const next = value[index + 1];
    const previousIsUpper =
      previous !== undefined && previous >= 'A' && previous <= 'Z';
    const currentIsUpper =
      current !== undefined && current >= 'A' && current <= 'Z';
    const nextIsLower = next !== undefined && next >= 'a' && next <= 'z';
    if (previousIsUpper && currentIsUpper && nextIsLower) {
      result += ' ';
    }
    result += current;
  }
  return result;
}

function splitSearchText(value: string): string {
  return splitAcronymBoundary(value)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase();
}

const QUERY_STOP_WORDS = new Set([
  'a',
  'about',
  'and',
  'are',
  'can',
  'contract',
  'does',
  'for',
  'from',
  'how',
  'i',
  'in',
  'is',
  'it',
  'me',
  'of',
  'on',
  'or',
  'protocol',
  'review',
  'stream',
  'support',
  'take',
  'tell',
  'that',
  'the',
  'this',
  'to',
  'what',
  'which',
  'who',
  'with'
]);

function tokens(value: string): Set<string> {
  const result = new Set<string>();
  const rawTokens =
    splitSearchText(value)
      .match(/[a-z0-9]+/g)
      ?.filter((token) => token.length > 1 && !QUERY_STOP_WORDS.has(token)) ??
    [];
  for (const token of rawTokens) {
    if (
      token.length > 3 &&
      token.endsWith('s') &&
      !/(ss|us|is|ias)$/.test(token)
    ) {
      result.add(token.slice(0, -1));
    } else {
      result.add(token);
    }
  }
  return result;
}

function technicalRecordId(record: StreamCatalogRecord): string {
  for (const prefix of ['declaration:', 'definition:']) {
    if (record.id.startsWith(prefix)) {
      return record.id.slice(prefix.length);
    }
  }
  return '';
}

function exactKeys(record: StreamCatalogRecord): string[] {
  const technicalId = technicalRecordId(record);
  const candidates = [
    record.id,
    technicalId,
    record.name,
    record.signature,
    record.selector,
    record.topic0,
    record.sourcePath,
    record.title,
    record.definitionName,
    record.definitionName && record.name
      ? `${record.definitionName}.${record.name}`
      : '',
    record.definitionName && record.signature
      ? `${record.definitionName}.${record.signature}`
      : '',
    ...record.aliases
  ].filter((entry): entry is string => !!entry);
  if (record.category === 'technical') {
    return candidates;
  }
  return candidates.filter(
    (entry) =>
      entry === record.id || normalizeExact(entry).split(/[\s/]+/).length >= 2
  );
}

function buildExactLookup(
  catalog: readonly StreamCatalogRecord[]
): ReadonlyMap<string, readonly StreamCatalogRecord[]> {
  const mutable = new Map<string, StreamCatalogRecord[]>();
  for (const record of catalog) {
    for (const rawKey of exactKeys(record)) {
      const key = normalizeExact(rawKey);
      if (!key || key.length > 500) {
        continue;
      }
      const records = mutable.get(key) ?? [];
      if (!records.some((candidate) => candidate.id === record.id)) {
        records.push(record);
      }
      mutable.set(key, records);
    }
  }
  return mutable;
}

function isStructuredTechnicalQuestion(question: string): boolean {
  return (
    /\b0x[0-9a-fA-F]{8,64}\b/.test(question) ||
    /\b[A-Za-z_$][A-Za-z0-9_$]*\s*\([^)]*\)/.test(question) ||
    /\b[A-Za-z0-9_./-]+\.sol\b/.test(question) ||
    hasCamelCaseIdentifier(question) ||
    /\b(?:function|event|error|selector|topic|signature|inputs?|outputs?|visibility|mutability|modifier|source path)\b/i.test(
      question
    )
  );
}

function hasCamelCaseIdentifier(value: string): boolean {
  for (const word of value.split(/[^A-Za-z0-9_$]+/)) {
    let hasLowercase = false;
    for (const character of word) {
      if (character >= 'a' && character <= 'z') {
        hasLowercase = true;
      } else if (hasLowercase && character >= 'A' && character <= 'Z') {
        return true;
      }
    }
  }
  return false;
}

function queryIntent(
  question: string,
  previousBotAnswer?: string | null
): QueryIntent {
  const normalized = splitSearchText(question).replace(/\s+/g, ' ').trim();
  const explicitlyStreamScoped =
    /\b(?:6529 )?stream\b/.test(normalized) ||
    /\bstream(?:auctions?|curation|administration|governance|collections?)\b/i.test(
      question
    ) ||
    (/\bauctions?\b/.test(normalized) &&
      /\b(?:artist|bid|curat|sale|reserve|credit)\w*\b/.test(normalized)) ||
    (/\bcurat\w*\b/.test(normalized) && /\btdh\b/.test(normalized));
  const technicalProbe = isStructuredTechnicalQuestion(question);
  const contextualFollowUp =
    !!previousBotAnswer &&
    /(?:6529 stream|\/reviews\/6529-stream|stream review)/i.test(
      previousBotAnswer
    ) &&
    /\b(?:can|could|does|how|it|that|this|there|what|when|where|who|why|withdraw)\b/.test(
      normalized
    );
  return {
    shouldTry: explicitlyStreamScoped || technicalProbe || contextualFollowUp,
    explicitlyStreamScoped: explicitlyStreamScoped || contextualFollowUp,
    broadStreamQuestion:
      explicitlyStreamScoped &&
      /\b(?:what is|explain|overview|tell me about)\b/.test(normalized) &&
      tokens(question).size <= 1,
    contextualFollowUp
  };
}

function extractedExactQueryKeys(question: string): string[] {
  const keys = new Set<string>();
  const addMatches = (pattern: RegExp, add: (value: string) => void): void => {
    let match = pattern.exec(question);
    while (match) {
      add(match[0]);
      match = pattern.exec(question);
    }
  };
  addMatches(/\b0x[0-9a-fA-F]{8,64}\b/g, (value) =>
    keys.add(normalizeExact(value))
  );
  addMatches(/\b[A-Za-z_$][A-Za-z0-9_$.]*\s*\([^)]*\)/g, (value) =>
    keys.add(normalizeExact(value))
  );
  addMatches(/\b[A-Za-z0-9_./-]+\.sol\b/g, (value) =>
    keys.add(normalizeExact(value))
  );
  addMatches(
    /\b[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)?\b/g,
    (value) => {
      if (
        !QUERY_STOP_WORDS.has(value.toLowerCase()) &&
        (value.length >= 10 || /[A-Z_.]/.test(value))
      ) {
        keys.add(normalizeExact(value));
      }
    }
  );
  return Array.from(keys);
}

function authorityScore(record: StreamCatalogRecord): number {
  let score = 0;
  if (record.scope === 'protocol') {
    score += 80;
  } else if (record.scope === 'script') {
    score += 20;
  }
  if (record.classification === 'production_release_contract') {
    score += 40;
  }
  return score;
}

function exactPriority(record: StreamCatalogRecord, key: string): number {
  const authority = authorityScore(record);
  if (normalizeExact(record.selector ?? '') === key) {
    return 1_600 + authority;
  }
  if (normalizeExact(record.topic0 ?? '') === key) {
    return 1_550 + authority;
  }
  if (normalizeExact(record.signature ?? '') === key) {
    return 1_500 + authority;
  }
  if (
    normalizeExact(
      record.definitionName && record.signature
        ? `${record.definitionName}.${record.signature}`
        : ''
    ) === key
  ) {
    return 1_525 + authority;
  }
  if (normalizeExact(record.title) === key) {
    return 1_450 + authority;
  }
  if (normalizeExact(record.name ?? '') === key) {
    return 1_350 + authority;
  }
  return 1_300 + authority;
}

function exactMatches(
  question: string,
  corpus: LoadedCorpus
): RankedCatalogRecord[] {
  const matchesById = new Map<string, RankedCatalogRecord>();
  for (const key of extractedExactQueryKeys(question)) {
    for (const record of corpus.exactLookup.get(key) ?? []) {
      const candidate = {
        record,
        score: exactPriority(record, key),
        exact: true
      };
      const existing = matchesById.get(record.id);
      if (!existing || candidate.score > existing.score) {
        matchesById.set(record.id, candidate);
      }
    }
  }
  const normalizedQuestion = normalizeExact(question);
  return Array.from(matchesById.values())
    .map((match) => ({
      ...match,
      score:
        match.score +
        (match.record.definitionName &&
        normalizedQuestion.includes(normalizeExact(match.record.definitionName))
          ? 120
          : 0)
    }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.record.id.localeCompare(right.record.id)
    );
}

function callableMetadataScore(
  question: string,
  record: StreamCatalogRecord
): number {
  if (
    /\b(?:function|inputs?|outputs?|visibility|mutability|modifier)\b/.test(
      question
    ) &&
    record.kind === 'function'
  ) {
    return 20;
  }
  if (/\bevents?\b/.test(question) && record.kind === 'event') {
    return 24;
  }
  if (/\berrors?\b/.test(question) && record.kind === 'error') {
    return 24;
  }
  return 0;
}

function scopeMetadataScore(
  question: string,
  record: StreamCatalogRecord
): number {
  if (/\b(?:script|sepolia|deploy|ceremony)\b/.test(question)) {
    if (record.scope === 'script') {
      return 32;
    }
    return record.scope === 'test' ? -8 : 0;
  }
  return /\bprotocol\b/.test(question) && record.scope === 'protocol' ? 24 : 0;
}

function metadataScore(question: string, record: StreamCatalogRecord): number {
  const statusScore =
    /\b(?:audit|blocker|deployment|readiness|release|risk|status)\b/.test(
      question
    ) && record.category === 'status'
      ? 30
      : 0;
  return (
    callableMetadataScore(question, record) +
    scopeMetadataScore(question, record) +
    statusScore
  );
}

function broadStreamScore(record: StreamCatalogRecord): number {
  if (record.id === 'editorial:overview:intro') {
    return 220;
  }
  if (record.id.startsWith('editorial:overview:')) {
    return 160;
  }
  return record.kind === 'review_status' ? 100 : 0;
}

function tokenOverlapScore(
  queryTokens: ReadonlySet<string>,
  record: StreamCatalogRecord
): number {
  const nameTokens = tokens(
    `${record.name ?? ''} ${record.definitionName ?? ''}`
  );
  const titleTokens = tokens(record.title);
  const searchTokens = tokens(
    `${record.searchText ?? ''} ${record.sourcePath ?? ''} ${
      record.classification ?? ''
    }`
  );
  let score = 0;
  queryTokens.forEach((token) => {
    if (nameTokens.has(token)) {
      score += 16;
    } else if (titleTokens.has(token)) {
      score += 8;
    } else if (searchTokens.has(token)) {
      score += 3;
    }
  });
  return score;
}

function lexicalScore(
  context: QueryContext,
  record: StreamCatalogRecord,
  broadStreamQuestion: boolean
): number {
  if (broadStreamQuestion) {
    const broadScore = broadStreamScore(record);
    if (broadScore > 0) {
      return broadScore;
    }
  }
  if (!context.queryTokens.size) {
    return 0;
  }
  const title = normalizeExact(record.title);
  const name = normalizeExact(record.name ?? '');
  const signature = normalizeExact(record.signature ?? '');
  const definitionName = normalizeExact(record.definitionName ?? '');
  let score = metadataScore(context.splitQuestion, record);
  if (title && context.normalizedQuestion.includes(title)) {
    score += 45;
  }
  if (
    signature &&
    ['function', 'event', 'error'].includes(record.kind) &&
    context.normalizedQuestion.includes(signature)
  ) {
    score += 55;
  }
  if (containsNormalizedTerm(context.normalizedQuestion, name)) {
    score += 35;
  }
  score += tokenOverlapScore(context.queryTokens, record);
  if (containsNormalizedTerm(context.normalizedQuestion, definitionName)) {
    score += 25;
  }
  if (record.category === 'technical' && record.scope === 'protocol') {
    score += 2;
  }
  return score;
}

function fuzzyMatches(
  question: string,
  corpus: LoadedCorpus,
  intent: QueryIntent
): RankedCatalogRecord[] {
  const context: QueryContext = {
    normalizedQuestion: normalizeExact(question),
    splitQuestion: splitSearchText(question),
    queryTokens: tokens(question)
  };
  const conceptualStreamQuestion =
    intent.explicitlyStreamScoped && !isStructuredTechnicalQuestion(question);
  return corpus.catalog
    .map((record) => ({
      record,
      score:
        lexicalScore(context, record, intent.broadStreamQuestion) +
        (conceptualStreamQuestion && record.category === 'editorial' ? 18 : 0),
      exact: false
    }))
    .filter((match) => match.score >= 8)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.record.id.localeCompare(right.record.id)
    );
}

function selectInitialCandidates(
  exact: readonly RankedCatalogRecord[],
  fuzzy: readonly RankedCatalogRecord[]
): RankedCatalogRecord[] {
  const selected: RankedCatalogRecord[] = [];
  const seen = new Set<string>();
  const categoryCounts = new Map<string, number>();
  const add = (match: RankedCatalogRecord): void => {
    if (
      seen.has(match.record.id) ||
      selected.length >= MAX_INITIAL_CANDIDATES
    ) {
      return;
    }
    seen.add(match.record.id);
    selected.push(match);
    categoryCounts.set(
      match.record.category,
      (categoryCounts.get(match.record.category) ?? 0) + 1
    );
  };
  exact.slice(0, 4).forEach(add);
  for (const match of fuzzy) {
    const cap = match.record.category === 'status' ? 2 : 4;
    if ((categoryCounts.get(match.record.category) ?? 0) >= cap) {
      continue;
    }
    add(match);
    if (selected.length >= MAX_INITIAL_CANDIDATES) {
      break;
    }
  }
  return selected;
}

function ambiguityMessage(
  question: string,
  exact: readonly RankedCatalogRecord[]
): string | null {
  const highest = exact[0];
  if (!highest?.record.name) {
    return null;
  }
  const sameName = exact.filter(
    (match) =>
      match.score >= highest.score - 25 &&
      match.record.name?.toLowerCase() === highest.record.name?.toLowerCase()
  );
  if (sameName.length <= 1) {
    return null;
  }
  const signatures = new Set(
    sameName.map(
      (match) =>
        `${match.record.signature ?? ''}:${
          match.record.selector ?? match.record.topic0 ?? ''
        }`
    )
  );
  if (signatures.size <= 1) {
    return null;
  }
  const normalizedQuestion = normalizeExact(question);
  const normalizedName = normalizeExact(highest.record.name);
  if (
    /\b0x[0-9a-f]{8,64}\b/i.test(question) ||
    normalizedQuestion.includes(`${normalizedName}(`) ||
    sameName.some(
      (match) =>
        match.record.definitionName &&
        normalizedQuestion.includes(normalizeExact(match.record.definitionName))
    )
  ) {
    return null;
  }
  const choices = sameName
    .slice(0, 4)
    .map(
      (match) =>
        `${match.record.definitionName ?? 'top-level'}.${
          match.record.signature ?? match.record.name
        }`
    )
    .join(', ');
  return `The exact symbol name is overloaded or declared in multiple definitions (${choices}). Do not choose one silently; ask for the contract or complete signature.`;
}

function uniqueById<T extends { readonly id: string }>(
  records: readonly T[]
): T[] {
  const seen = new Set<string>();
  return records.filter((record) => {
    if (seen.has(record.id)) {
      return false;
    }
    seen.add(record.id);
    return true;
  });
}

function bounded(value: string, maxCharacters: number): string {
  return value.length <= maxCharacters
    ? value
    : `${value.slice(0, maxCharacters - 1)}…`;
}

function selectedTechnicalFacts(record: StreamEvidenceRecord): unknown {
  const technical = asObject(record.technical);
  const declaration = asObject(technical?.declaration);
  if (!technical && !declaration) {
    return undefined;
  }
  return {
    definitionName: readString(technical?.definitionName),
    definitionKind: readString(technical?.definitionKind),
    inheritance: technical?.definitionInheritance,
    declaration: declaration
      ? {
          name: declaration.name,
          canonicalSignature: declaration.canonicalSignature,
          displaySignature: declaration.displaySignature,
          selector: declaration.selector,
          topic0: declaration.topic0,
          inputs: declaration.inputs,
          outputs: declaration.outputs,
          visibility: declaration.visibility,
          stateMutability: declaration.stateMutability,
          modifiers: declaration.modifiers,
          anonymous: declaration.anonymous,
          syntheticGetter: declaration.syntheticGetter,
          natspec: declaration.natspec,
          members: declaration.members,
          type: declaration.type,
          typeString: declaration.typeString
        }
      : undefined
  };
}

function formatEvidenceRecord(
  record: StreamEvidenceRecord,
  index: number
): string {
  const provenance = asObject(record.provenance);
  const structured = record.structured;
  const evidenceStates = Array.isArray(record.evidenceStates)
    ? record.evidenceStates
    : undefined;
  const payload: Record<string, unknown> = {
    evidence: index,
    id: record.id,
    category: record.category,
    kind: record.kind,
    title: record.title,
    scope: record.scope,
    classification: record.classification,
    summary: record.summary,
    text: record.text,
    evidenceStates,
    technical: selectedTechnicalFacts(record),
    structured,
    implementationExcerpt: record.bodyExcerpt,
    canonicalPath: record.canonicalPath,
    sourceLink: record.sourceLink,
    sourcePath: readString(provenance?.sourcePath),
    lineRange: asObject(provenance?.range)
  };
  let serialized = JSON.stringify(canonicalize(payload));
  if (serialized.length <= MAX_EVIDENCE_RECORD_CHARACTERS) {
    return serialized;
  }
  payload.text = bounded(String(record.text ?? ''), 700) || undefined;
  payload.summary = bounded(String(record.summary ?? ''), 420) || undefined;
  payload.implementationExcerpt =
    bounded(String(record.bodyExcerpt ?? ''), 500) || undefined;
  payload.structuredExcerpt = structured
    ? bounded(JSON.stringify(canonicalize(structured)), 500)
    : undefined;
  delete payload.structured;
  serialized = JSON.stringify(canonicalize(payload));
  if (serialized.length <= MAX_EVIDENCE_RECORD_CHARACTERS) {
    return serialized;
  }
  payload.technicalExcerpt = payload.technical
    ? bounded(JSON.stringify(canonicalize(payload.technical)), 900)
    : undefined;
  delete payload.technical;
  serialized = JSON.stringify(canonicalize(payload));
  if (serialized.length <= MAX_EVIDENCE_RECORD_CHARACTERS) {
    return serialized;
  }
  return JSON.stringify(
    canonicalize({
      evidence: index,
      id: record.id,
      category: record.category,
      kind: record.kind,
      title: record.title,
      scope: record.scope,
      classification: record.classification,
      canonicalPath: record.canonicalPath,
      contentExcerpt: bounded(serialized, 900)
    })
  );
}

function selectBoundedEvidenceRecords(
  records: readonly string[],
  prefixCharacters: number
): string[] {
  const selected: string[] = [];
  let characters = prefixCharacters;
  for (const record of records.slice(0, MAX_EVIDENCE_RECORDS)) {
    if (characters + record.length > MAX_EVIDENCE_PACKET_CHARACTERS) {
      break;
    }
    selected.push(record);
    characters += record.length;
  }
  return selected;
}

function evidencePacketRecord(
  selection: EvidenceSelection,
  manifest: StreamKnowledgeManifest
): HelpBotKnowledgeRecord {
  const corpusIdentity = `Corpus identity: review ${REVIEW_ID}, version ${manifest.reviewVersion}, pinned ${manifest.source.repository}@${manifest.source.commit}; lifecycle ${manifest.publication.lifecycleState}, audit ${manifest.publication.auditStatus}, deployment ${manifest.publication.deploymentStatus}.`;
  const ambiguityBudget = Math.max(
    0,
    MAX_EVIDENCE_METADATA_CHARACTERS - corpusIdentity.length
  );
  const ambiguity =
    selection.ambiguity && ambiguityBudget > 0
      ? bounded(`AMBIGUITY: ${selection.ambiguity}`, ambiguityBudget)
      : '';
  const formattedRecords = selectBoundedEvidenceRecords(
    selection.records.map((record, index) =>
      formatEvidenceRecord(record, index + 1)
    ),
    corpusIdentity.length + ambiguity.length
  );
  const primaryPath = selection.primary.canonicalPath;
  const relatedPaths = uniqueById(
    selection.records.map((record) => ({
      id: record.canonicalPath,
      path: record.canonicalPath
    }))
  )
    .map((entry) => entry.path)
    .filter((path) => path !== primaryPath);
  const facts = [corpusIdentity, ambiguity, ...formattedRecords].filter(
    Boolean
  );
  return {
    id: `${REVIEW_ID}@${manifest.reviewVersion}`,
    kind: 'public_review_knowledge',
    title: `6529 Stream review evidence (${manifest.reviewVersion})`,
    linkLabel: '6529 Stream Review',
    canonicalPath: primaryPath,
    aliases: ['stream', '6529 stream', 'stream protocol', 'stream review'],
    keywords: ['stream', 'solidity', 'public review'],
    facts,
    relatedPaths,
    tags: [
      'stream',
      manifest.publication.lifecycleState.toLowerCase(),
      manifest.publication.auditStatus.toLowerCase(),
      manifest.publication.deploymentStatus.toLowerCase()
    ],
    sourceRefs: [
      `${manifest.source.repository}@${manifest.source.commit}`,
      `knowledge:${manifest.knowledgeSha256}`,
      `reference:${manifest.reference.bundleSha256}`
    ]
  };
}

export class FrontendStreamKnowledgeSource implements HelpBotStreamKnowledgeSource {
  private readonly logger = Logger.get(this.constructor.name);
  private corpus: LoadedCorpus | null = null;
  private cacheExpiresAt = 0;
  private refreshPromise: Promise<LoadedCorpus | null> | null = null;
  private readonly shardCache = new Map<
    string,
    Promise<ReadonlyMap<string, StreamEvidenceRecord>>
  >();

  constructor(
    private readonly fetcher: StreamKnowledgeFetcher = fetchWithTimeout,
    private readonly baseUrl: string = HELP_BOT_BASE_URL,
    private readonly cacheTtlMs: number = HELP_BOT_INDEX_CACHE_TTL_MS
  ) {}

  public async findMatch(
    question: string,
    previousBotAnswer?: string | null
  ): Promise<HelpBotKnowledgeMatch | null> {
    const intent = queryIntent(question, previousBotAnswer);
    if (!intent.shouldTry) {
      return null;
    }
    const corpus = await this.loadCorpus();
    if (!corpus) {
      return null;
    }
    const directExact = exactMatches(question, corpus);
    const exact =
      directExact.length === 0 && intent.contextualFollowUp && previousBotAnswer
        ? exactMatches(previousBotAnswer, corpus)
        : directExact;
    if (!intent.explicitlyStreamScoped && exact.length === 0) {
      return null;
    }
    const fuzzy = fuzzyMatches(question, corpus, intent);
    const initial = selectInitialCandidates(exact, fuzzy);
    if (initial.length === 0) {
      return null;
    }
    const selection = await this.loadEvidenceSelection(
      question,
      corpus,
      initial,
      exact,
      fuzzy
    );
    if (!selection) {
      return null;
    }
    return {
      score: selection.score,
      record: evidencePacketRecord(selection, corpus.manifest)
    };
  }

  private async loadCorpus(): Promise<LoadedCorpus | null> {
    const now = Date.now();
    if (now < this.cacheExpiresAt) {
      return this.corpus;
    }
    if (!this.refreshPromise) {
      this.refreshPromise = this.refreshCorpus(now).finally(() => {
        this.refreshPromise = null;
      });
    }
    return this.refreshPromise;
  }

  private async refreshCorpus(now: number): Promise<LoadedCorpus | null> {
    try {
      const reviewIndexText = await this.fetchText(
        REVIEW_INDEX_PATH,
        MAX_MANIFEST_CHARACTERS,
        true
      );
      if (reviewIndexText === null) {
        return this.disableCorpus(now);
      }
      const projected = parseActiveReferenceVersion(
        JSON.parse(reviewIndexText)
      );
      if (!projected) {
        return this.disableCorpus(now);
      }
      const knowledgePrefix = `/review-data/${REVIEW_ID}/versions/${projected.version}/knowledge`;
      const manifestText = await this.fetchText(
        `${knowledgePrefix}/manifest.json`,
        MAX_MANIFEST_CHARACTERS,
        true
      );
      if (manifestText === null) {
        return this.disableCorpus(now);
      }
      const manifest = parseManifest(JSON.parse(manifestText), projected);
      if (!manifest) {
        return this.disableCorpus(now);
      }
      const cacheKey = `${manifest.reviewVersion}:${manifest.knowledgeSha256}`;
      if (this.corpus?.cacheKey === cacheKey) {
        this.cacheExpiresAt = now + this.cacheTtlMs;
        return this.corpus;
      }
      const catalogText = await this.fetchText(
        manifest.searchIndex.path,
        MAX_SEARCH_INDEX_CHARACTERS,
        false
      );
      if (
        catalogText === null ||
        sha256(catalogText) !== manifest.searchIndex.sha256
      ) {
        return this.disableCorpus(now);
      }
      const catalog = parseCatalog(JSON.parse(catalogText), manifest);
      if (!catalog) {
        return this.disableCorpus(now);
      }
      const corpus: LoadedCorpus = {
        cacheKey,
        manifest,
        catalog,
        byId: new Map(catalog.map((record) => [record.id, record])),
        exactLookup: buildExactLookup(catalog)
      };
      this.corpus = corpus;
      this.cacheExpiresAt = now + this.cacheTtlMs;
      this.shardCache.clear();
      return corpus;
    } catch (error) {
      this.logger.warn(
        'Could not refresh the published Stream knowledge pack',
        error
      );
      return this.disableCorpus(now);
    }
  }

  private disableCorpus(now: number): null {
    this.corpus = null;
    this.shardCache.clear();
    this.cacheExpiresAt =
      now + Math.min(this.cacheTtlMs, UNAVAILABLE_RETRY_TTL_MS);
    return null;
  }

  private async fetchText(
    path: string,
    maxCharacters: number,
    allowNotFound: boolean
  ): Promise<string | null> {
    const response = await this.fetcher(
      new URL(path, this.baseUrl).toString(),
      HELP_BOT_INDEX_FETCH_TIMEOUT_MS
    );
    if (allowNotFound && response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(
        `Stream knowledge fetch returned HTTP ${response.status}`
      );
    }
    const text = response.text;
    if (text.length > maxCharacters) {
      throw new Error(
        `Stream knowledge response exceeded ${maxCharacters} characters`
      );
    }
    return text;
  }

  private async loadShard(
    corpus: LoadedCorpus,
    shardNumber: number
  ): Promise<ReadonlyMap<string, StreamEvidenceRecord>> {
    const shardManifest = corpus.manifest.recordShards[shardNumber];
    if (!shardManifest) {
      throw new Error(`Unknown Stream knowledge shard ${shardNumber}`);
    }
    const key = `${corpus.cacheKey}:${shardManifest.sha256}`;
    const cached = this.shardCache.get(key);
    if (cached) {
      return cached;
    }
    const pending = (async () => {
      const text = await this.fetchText(
        shardManifest.path,
        MAX_SHARD_CHARACTERS,
        false
      );
      if (!text || sha256(text) !== shardManifest.sha256) {
        throw new Error(`Stream knowledge shard ${shardNumber} drifted`);
      }
      const records = parseEvidenceShard(
        JSON.parse(text),
        corpus.manifest,
        shardNumber
      );
      if (!records) {
        throw new Error(`Stream knowledge shard ${shardNumber} is invalid`);
      }
      return new Map(records.map((record) => [record.id, record]));
    })();
    this.shardCache.set(key, pending);
    try {
      return await pending;
    } catch (error) {
      this.shardCache.delete(key);
      throw error;
    }
  }

  private async loadRecords(
    corpus: LoadedCorpus,
    catalogRecords: readonly StreamCatalogRecord[]
  ): Promise<StreamEvidenceRecord[]> {
    const shardNumbers = Array.from(
      new Set(catalogRecords.map((record) => record.recordShard))
    );
    const shards = new Map(
      await Promise.all(
        shardNumbers.map(
          async (shardNumber) =>
            [shardNumber, await this.loadShard(corpus, shardNumber)] as const
        )
      )
    );
    return catalogRecords.map((record) => {
      const evidence = shards.get(record.recordShard)?.get(record.id);
      if (!evidence) {
        throw new Error(`Stream evidence record ${record.id} is missing`);
      }
      return evidence;
    });
  }

  private async loadEvidenceSelection(
    question: string,
    corpus: LoadedCorpus,
    initial: readonly RankedCatalogRecord[],
    exact: readonly RankedCatalogRecord[],
    fuzzy: readonly RankedCatalogRecord[]
  ): Promise<EvidenceSelection | null> {
    try {
      const initialEvidence = await this.loadRecords(
        corpus,
        initial.map((match) => match.record)
      );
      const relatedIds: string[] = [];
      for (const evidence of initialEvidence.slice(0, 4)) {
        const relationships = asObject(evidence.relationships);
        const definitionId = readString(relationships?.relatedDefinitionId);
        if (definitionId) {
          relatedIds.push(definitionId);
        }
        relatedIds.push(
          ...readStringArray(relationships?.relatedEditorialIds).slice(0, 2)
        );
      }
      const relatedCatalog = relatedIds
        .map((id) => corpus.byId.get(id))
        .filter((record): record is StreamCatalogRecord => !!record);
      const orderedCatalog = uniqueById([
        ...initial.map((match) => match.record),
        ...relatedCatalog,
        ...fuzzy.slice(0, MAX_EVIDENCE_RECORDS).map((match) => match.record)
      ]).slice(0, MAX_EVIDENCE_RECORDS);
      const evidenceById = new Map(
        initialEvidence.map((record) => [record.id, record])
      );
      const missing = orderedCatalog.filter(
        (record) => !evidenceById.has(record.id)
      );
      for (const record of await this.loadRecords(corpus, missing)) {
        evidenceById.set(record.id, record);
      }
      const records = orderedCatalog
        .map((record) => evidenceById.get(record.id))
        .filter((record): record is StreamEvidenceRecord => !!record);
      if (!records.length) {
        return null;
      }
      return {
        records,
        primary: records[0],
        score: initial[0]?.score ?? 0,
        ambiguity: ambiguityMessage(question, exact)
      };
    } catch (error) {
      this.logger.warn('Could not load selected Stream evidence shards', error);
      return null;
    }
  }
}

export const frontendStreamKnowledgeSource =
  new FrontendStreamKnowledgeSource();

export const STREAM_KNOWLEDGE_TESTING = {
  MAX_CATALOG_RECORDS,
  MAX_EVIDENCE_METADATA_CHARACTERS,
  MAX_EVIDENCE_PACKET_CHARACTERS,
  MAX_EVIDENCE_RECORD_CHARACTERS,
  MAX_EVIDENCE_RECORDS,
  MAX_RECORD_SHARDS,
  MIN_EVIDENCE_RECORDS,
  fetchWithTimeout,
  queryIntent,
  selectBoundedEvidenceRecords,
  stableJson
};
