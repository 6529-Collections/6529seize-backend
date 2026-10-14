import { getBedrockClient } from '@/bedrock';
import {
  DEFAULT_CLAUDE_SONNET_5_5_BEDROCK_MODEL_ID,
  getConfiguredBedrockAnthropicModelId
} from '@/bedrock.config';
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
  InvokeModelCommandInput
} from '@aws-sdk/client-bedrock-runtime';
import { TextDecoder } from 'node:util';
import {
  RELEASE_DIGEST_INSTRUCTIONS,
  RELEASE_DIGEST_RESPONSE_SCHEMA,
  RELEASE_DIGEST_SYSTEM_PROMPT
} from './release-digest.prompt';

export const RELEASE_DIGEST_BEDROCK_MODEL_ID_ENV =
  'RELEASE_DIGEST_BEDROCK_MODEL_ID';

const RELEASE_DIGEST_MAX_OUTPUT_TOKENS = 16_000;
const RELEASE_DIGEST_TIMEOUT_MS = 150_000;
const MAX_BODY_EXCERPT_LENGTH = 1_500;
const MAX_TITLE_LENGTH = 300;
const MAX_SUMMARY_LENGTH = 600;
const MAX_HEADLINE_LENGTH = 160;
const MAX_ITEM_TEXT_LENGTH = 400;
const MAX_AREA_LENGTH = 40;
const MAX_NOTE_LENGTH = 600;

export interface ReleaseDigestSourceEntry {
  readonly key: string;
  readonly repository: string;
  readonly services: readonly string[];
  readonly title: string;
  readonly summary: string;
  readonly body: string | null;
}

export interface ReleaseDigestItem {
  readonly area: string;
  readonly text: string;
  readonly entryKeys: readonly string[];
}

export interface ReleaseDigestDraft {
  readonly headline: string;
  readonly newItems: readonly ReleaseDigestItem[];
  readonly fixedItems: readonly ReleaseDigestItem[];
  readonly securityItems: readonly ReleaseDigestItem[];
  readonly knownIssues: readonly ReleaseDigestItem[];
  readonly behindTheScenes: string;
  readonly behindTheScenesKeys: readonly string[];
  readonly buildersNote: string;
}

interface AnthropicResponse {
  readonly stop_reason?: string;
  readonly content?: ReadonlyArray<{
    readonly type?: string;
    readonly text?: string;
  }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getRepositoryLabel(repository: string): string {
  const name = repository.split('/').pop() ?? repository;
  return name.replace(/^6529seize-/, '').replace(/^6529-/, '');
}

function serializeContext(entries: readonly ReleaseDigestSourceEntry[]) {
  const payload = entries.map((entry) => ({
    id: entry.key,
    repository: getRepositoryLabel(entry.repository),
    services: entry.services,
    title: entry.title.slice(0, MAX_TITLE_LENGTH),
    summary: entry.summary.slice(0, MAX_SUMMARY_LENGTH),
    details: entry.body?.slice(0, MAX_BODY_EXCERPT_LENGTH) ?? null
  }));
  return JSON.stringify(payload, null, 1).replace(/[<>]/g, (character) =>
    character === '<' ? String.raw`\u003c` : String.raw`\u003e`
  );
}

export function buildReleaseDigestPrompt(
  entries: readonly ReleaseDigestSourceEntry[]
): string {
  return [
    RELEASE_DIGEST_INSTRUCTIONS,
    '',
    'Production changes follow between <release_context> tags.',
    '<release_context>',
    serializeContext(entries),
    '</release_context>'
  ].join('\n');
}

export function buildReleaseDigestInvokeModelInput(
  modelId: string,
  prompt: string
): InvokeModelCommandInput {
  return {
    modelId,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: RELEASE_DIGEST_MAX_OUTPUT_TOKENS,
      system: RELEASE_DIGEST_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      output_config: {
        effort: 'high',
        format: { type: 'json_schema', schema: RELEASE_DIGEST_RESPONSE_SCHEMA }
      }
    })
  };
}

export function parseReleaseDigestResponseBody(body: Uint8Array): unknown {
  const parsed = JSON.parse(
    new TextDecoder().decode(body)
  ) as AnthropicResponse;
  if (parsed.stop_reason && parsed.stop_reason !== 'end_turn') {
    throw new Error(`Release digest generation stopped: ${parsed.stop_reason}`);
  }
  const text = parsed.content
    ?.filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('')
    .trim();
  if (!text) {
    throw new Error('Release digest generation returned no text');
  }
  return JSON.parse(text);
}

function cleanText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') {
    return '';
  }
  return (
    value
      .replace(/\s+/g, ' ')
      .replace(/@\[/g, '@(')
      // Bounded quantifiers keep link stripping linear on hostile input.
      .replace(/\[([^\]]{0,300})\]\([^)\s]{0,500}\)/g, '$1')
      .replace(/[`*~[\]#<>]/g, '')
      .replace(/^\s*[-•]\s*/, '')
      .trim()
      .slice(0, maxLength)
      .trim()
  );
}

function parseItems(
  value: unknown,
  knownKeys: ReadonlySet<string>
): ReleaseDigestItem[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((candidate) => {
    if (!isRecord(candidate)) {
      return [];
    }
    const text = cleanText(candidate.text, MAX_ITEM_TEXT_LENGTH);
    const area = cleanText(candidate.area, MAX_AREA_LENGTH);
    const entryKeys = Array.isArray(candidate.entry_ids)
      ? candidate.entry_ids.filter(
          (key): key is string => typeof key === 'string' && knownKeys.has(key)
        )
      : [];
    return text && entryKeys.length ? [{ area, text, entryKeys }] : [];
  });
}

function itemsOfKind(
  sections: unknown,
  kind: string,
  knownKeys: ReadonlySet<string>
): ReleaseDigestItem[] {
  if (!Array.isArray(sections)) {
    return [];
  }
  return sections
    .filter((section) => isRecord(section) && section.kind === kind)
    .flatMap((section) =>
      parseItems((section as Record<string, unknown>).items, knownKeys)
    );
}

/**
 * Validates model output against the entries it was given. Unknown ids are
 * dropped, and entries the model left out are counted as behind-the-scenes
 * work so every claimed change is still accounted for.
 */
export function toReleaseDigestDraft(
  value: unknown,
  entries: readonly ReleaseDigestSourceEntry[]
): ReleaseDigestDraft {
  if (!isRecord(value)) {
    throw new Error('Release digest response is not an object');
  }
  const knownKeys = new Set(entries.map((entry) => entry.key));
  const newItems = itemsOfKind(value.sections, 'new', knownKeys);
  const fixedItems = itemsOfKind(value.sections, 'fixed', knownKeys);
  const securityItems = itemsOfKind(value.sections, 'security', knownKeys);
  const knownIssues = parseItems(value.known_issues, knownKeys);
  const visibleKeys = new Set(
    [...newItems, ...fixedItems, ...securityItems, ...knownIssues].flatMap(
      (item) => item.entryKeys
    )
  );
  const behindTheScenesKeys = entries
    .map((entry) => entry.key)
    .filter((key) => !visibleKeys.has(key));
  const behindTheScenes = isRecord(value.behind_the_scenes)
    ? cleanText(value.behind_the_scenes.text, MAX_NOTE_LENGTH)
    : '';
  const headline = cleanText(value.headline, MAX_HEADLINE_LENGTH);
  if (!headline) {
    throw new Error('Release digest response is missing a headline');
  }
  return {
    headline,
    newItems,
    fixedItems,
    securityItems,
    knownIssues,
    behindTheScenes,
    behindTheScenesKeys,
    buildersNote: cleanText(value.builders_note, MAX_NOTE_LENGTH)
  };
}

export class ReleaseDigestWriter {
  constructor(
    // Resolved per call so a model override loaded from secrets applies.
    private readonly getModelId: () => string = getReleaseDigestModelId,
    private readonly getBedrock: () => BedrockRuntimeClient = getBedrockClient,
    private readonly timeoutMs: number = RELEASE_DIGEST_TIMEOUT_MS
  ) {}

  public async write(
    entries: readonly ReleaseDigestSourceEntry[]
  ): Promise<ReleaseDigestDraft> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.getBedrock().send(
        new InvokeModelCommand(
          buildReleaseDigestInvokeModelInput(
            this.getModelId(),
            buildReleaseDigestPrompt(entries)
          )
        ),
        { abortSignal: controller.signal }
      );
      if (!response.body) {
        throw new Error('Release digest generation returned no body');
      }
      return toReleaseDigestDraft(
        parseReleaseDigestResponseBody(response.body),
        entries
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function getReleaseDigestModelId(): string {
  return getConfiguredBedrockAnthropicModelId(
    RELEASE_DIGEST_BEDROCK_MODEL_ID_ENV,
    DEFAULT_CLAUDE_SONNET_5_5_BEDROCK_MODEL_ID
  );
}
