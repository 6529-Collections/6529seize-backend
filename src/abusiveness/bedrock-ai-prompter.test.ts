import {
  buildAbusivenessBedrockInvokeModelInput,
  DEFAULT_ABUSIVENESS_BEDROCK_MODEL_ID,
  getAbusivenessBedrockModelId
} from './bedrock-ai.prompter';
import { DEFAULT_CLAUDE_SONNET_4_5_BEDROCK_MODEL_ID } from '@/bedrock.config';

describe('bedrock abusiveness prompter', () => {
  const originalModelId = process.env.ABUSIVENESS_BEDROCK_MODEL_ID;

  afterEach(() => {
    if (originalModelId === undefined) {
      delete process.env.ABUSIVENESS_BEDROCK_MODEL_ID;
    } else {
      process.env.ABUSIVENESS_BEDROCK_MODEL_ID = originalModelId;
    }
  });

  it('uses the shared Claude Sonnet 4.5 default model', () => {
    expect(DEFAULT_ABUSIVENESS_BEDROCK_MODEL_ID).toBe(
      DEFAULT_CLAUDE_SONNET_4_5_BEDROCK_MODEL_ID
    );
    expect(DEFAULT_ABUSIVENESS_BEDROCK_MODEL_ID).toBe(
      'us.anthropic.claude-sonnet-4-5-20250929-v1:0'
    );
  });

  it('resolves the service model override at call time', () => {
    delete process.env.ABUSIVENESS_BEDROCK_MODEL_ID;
    expect(getAbusivenessBedrockModelId()).toBe(
      DEFAULT_ABUSIVENESS_BEDROCK_MODEL_ID
    );

    process.env.ABUSIVENESS_BEDROCK_MODEL_ID = ' override-model ';
    expect(getAbusivenessBedrockModelId()).toBe('override-model');
  });

  it('sends a Sonnet 5.5 payload with low effort and a JSON schema', () => {
    const input = buildAbusivenessBedrockInvokeModelInput(
      'us.anthropic.claude-sonnet-5-5',
      'is this category okay?'
    );
    const body = JSON.parse(input.body as string) as Record<string, unknown>;

    expect(input.modelId).toBe('us.anthropic.claude-sonnet-5-5');
    expect(body).toMatchObject({
      output_config: {
        effort: 'low',
        format: {
          type: 'json_schema',
          schema: {
            required: ['value'],
            properties: {
              value: { type: 'string', enum: ['Allowed', 'Disallowed'] }
            }
          }
        }
      }
    });
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('top_k');
    expect(body).not.toHaveProperty('top_p');
  });

  it('keeps the Sonnet 4.5 sampling payload for Sonnet 4.5', () => {
    const input = buildAbusivenessBedrockInvokeModelInput(
      'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
      'is this category okay?'
    );
    const body = JSON.parse(input.body as string) as Record<string, unknown>;

    expect(body).toMatchObject({
      temperature: 0.7,
      top_k: 30
    });
    expect(body).not.toHaveProperty('output_config');
    expect(body).not.toHaveProperty('top_p');
  });
});
