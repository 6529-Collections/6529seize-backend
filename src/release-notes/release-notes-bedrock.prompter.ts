import { AiPrompter } from '@/abusiveness/ai-prompter';
import { getBedrockClient } from '@/bedrock';
import {
  DEFAULT_CLAUDE_SONNET_4_5_BEDROCK_MODEL_ID,
  getConfiguredBedrockAnthropicModelId
} from '@/bedrock.config';
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
  InvokeModelCommandInput
} from '@aws-sdk/client-bedrock-runtime';
import { TextDecoder } from 'node:util';

export const RELEASE_NOTES_BEDROCK_MODEL_ID_ENV =
  'RELEASE_NOTES_BEDROCK_MODEL_ID';
export const DEFAULT_RELEASE_NOTES_BEDROCK_MODEL_ID =
  DEFAULT_CLAUDE_SONNET_4_5_BEDROCK_MODEL_ID;

const RELEASE_NOTES_MAX_OUTPUT_TOKENS = 8192;
const RELEASE_NOTES_BEDROCK_TIMEOUT_MS = 60_000;

interface AnthropicResponse {
  readonly content?: ReadonlyArray<{
    readonly type?: string;
    readonly text?: string;
  }>;
}

export function buildReleaseNotesBedrockInvokeModelInput(
  modelId: string,
  prompt: string
): InvokeModelCommandInput {
  return {
    modelId,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: RELEASE_NOTES_MAX_OUTPUT_TOKENS,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: prompt }]
        }
      ],
      temperature: 0
    })
  };
}

function parseAnthropicResponse(body: Uint8Array): string {
  const jsonString = new TextDecoder().decode(body);
  const parsed = JSON.parse(jsonString) as AnthropicResponse;
  const text = parsed.content
    ?.filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('')
    .trim();
  if (!text) {
    throw new Error(`Unexpected empty response from Bedrock: ${jsonString}`);
  }
  return text;
}

export class ReleaseNotesBedrockPrompter implements AiPrompter {
  constructor(
    private readonly modelId: string,
    private readonly getBedrock: () => BedrockRuntimeClient = getBedrockClient,
    private readonly timeoutMs: number = RELEASE_NOTES_BEDROCK_TIMEOUT_MS
  ) {}

  public async promptAndGetReply(prompt: string): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.getBedrock().send(
        new InvokeModelCommand(
          buildReleaseNotesBedrockInvokeModelInput(this.modelId, prompt)
        ),
        { abortSignal: controller.signal }
      );
      if (!response.body) {
        throw new Error('Unexpected empty response body from Bedrock');
      }
      return parseAnthropicResponse(response.body);
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function getReleaseNotesBedrockModelId(): string {
  return getConfiguredBedrockAnthropicModelId(
    RELEASE_NOTES_BEDROCK_MODEL_ID_ENV,
    DEFAULT_RELEASE_NOTES_BEDROCK_MODEL_ID
  );
}

export const releaseNotesBedrockPrompter = new ReleaseNotesBedrockPrompter(
  getReleaseNotesBedrockModelId()
);
