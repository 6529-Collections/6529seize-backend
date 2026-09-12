import {
  buildAbusivenessBedrockInvokeModelInput,
  DEFAULT_ABUSIVENESS_BEDROCK_MODEL_ID
} from './bedrock-ai.prompter';
import { DEFAULT_CLAUDE_SONNET_4_5_BEDROCK_MODEL_ID } from '@/bedrock.config';

describe('bedrock abusiveness prompter', () => {
  it('uses the shared Claude Sonnet 4.5 default model', () => {
    expect(DEFAULT_ABUSIVENESS_BEDROCK_MODEL_ID).toBe(
      DEFAULT_CLAUDE_SONNET_4_5_BEDROCK_MODEL_ID
    );
    expect(DEFAULT_ABUSIVENESS_BEDROCK_MODEL_ID).toBe(
      'us.anthropic.claude-sonnet-4-5-20250929-v1:0'
    );
  });

  it('uses a Sonnet 4.5-compatible Anthropic Bedrock payload', () => {
    const input = buildAbusivenessBedrockInvokeModelInput(
      'anthropic.test-model',
      'is this category okay?'
    );
    const body = JSON.parse(input.body as string) as Record<string, unknown>;

    expect(input.modelId).toBe('anthropic.test-model');
    expect(body).toMatchObject({
      temperature: 0.7,
      top_k: 30
    });
    expect(body).not.toHaveProperty('top_p');
  });
});
