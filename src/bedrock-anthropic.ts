import { TextDecoder } from 'node:util';

export type BedrockAnthropicEffort = 'low' | 'medium' | 'high';

export interface LegacyClaudeSamplingParams {
  readonly temperature?: number;
  readonly top_k?: number;
}

export interface BedrockAnthropicRequest {
  readonly modelId: string;
  readonly prompt: string;
  readonly maxTokens: number;
  readonly effort: BedrockAnthropicEffort;
  readonly system?: string;
  readonly jsonSchema?: Record<string, unknown>;
  /**
   * Sent only to Claude models older than 4.6, which reject
   * output_config.effort. Keeping the previous sampling values lets a
   * per-service *_BEDROCK_MODEL_ID override roll back to Sonnet 4.5 unchanged.
   */
  readonly legacySampling?: LegacyClaudeSamplingParams;
}

export interface BedrockAnthropicReply {
  readonly text: string;
  readonly stopReason: string | null;
  readonly raw: string;
}

interface BedrockAnthropicResponseBody {
  readonly content?: ReadonlyArray<{
    readonly type?: unknown;
    readonly text?: unknown;
  }>;
  readonly stop_reason?: unknown;
  readonly stop_details?: { readonly category?: unknown } | null;
}

// Claude 3.x and 4.0-4.5 model IDs, for example
// us.anthropic.claude-sonnet-4-5-20250929-v1:0 or
// us.anthropic.claude-sonnet-4-20250514-v1:0.
const PRE_4_6_CLAUDE_MODEL_PATTERN =
  /claude-(?:3-|(?:sonnet|opus|haiku)-4-(?:[0-5](?!\d)|\d{8}))/;

export function isPre46ClaudeModel(modelId: string): boolean {
  return PRE_4_6_CLAUDE_MODEL_PATTERN.test(modelId);
}

export class BedrockAnthropicRefusalError extends Error {
  constructor(public readonly category: string | null) {
    super(`Bedrock model declined the request (${category ?? 'unspecified'})`);
    this.name = 'BedrockAnthropicRefusalError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function buildBedrockAnthropicBody(
  request: BedrockAnthropicRequest
): string {
  const base = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: request.maxTokens,
    ...(request.system ? { system: request.system } : {}),
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: request.prompt }]
      }
    ]
  };
  if (isPre46ClaudeModel(request.modelId)) {
    return JSON.stringify({ ...base, ...request.legacySampling });
  }
  // Claude 4.6+ rejects non-default sampling parameters. Thinking stays
  // adaptive (the default); effort bounds how much the model thinks.
  return JSON.stringify({
    ...base,
    output_config: {
      effort: request.effort,
      ...(request.jsonSchema
        ? { format: { type: 'json_schema', schema: request.jsonSchema } }
        : {})
    }
  });
}

function readRefusalCategory(
  parsed: BedrockAnthropicResponseBody
): string | null {
  const category = parsed.stop_details?.category;
  return typeof category === 'string' ? category : null;
}

/**
 * Reads the reply text by content block type. Newer Claude models can return
 * thinking blocks before the text block, so content[0] is not the answer.
 */
export function parseBedrockAnthropicReply(
  body: Uint8Array
): BedrockAnthropicReply {
  const raw = new TextDecoder().decode(body);
  const parsed = JSON.parse(raw) as BedrockAnthropicResponseBody;
  if (parsed.stop_reason === 'refusal') {
    throw new BedrockAnthropicRefusalError(readRefusalCategory(parsed));
  }
  const text = (parsed.content ?? [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('');
  return {
    text,
    stopReason:
      typeof parsed.stop_reason === 'string' ? parsed.stop_reason : null,
    raw
  };
}
