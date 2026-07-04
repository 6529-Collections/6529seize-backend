import {
  buildAbusivenessBedrockInvokeModelInput,
  DEFAULT_ABUSIVENESS_BEDROCK_MODEL_ID
} from './bedrock-ai.prompter';

describe('bedrock abusiveness prompter', () => {
  it('keeps the historical Claude 3 Sonnet default model', () => {
    expect(DEFAULT_ABUSIVENESS_BEDROCK_MODEL_ID).toBe(
      'anthropic.claude-3-sonnet-20240229-v1:0'
    );
  });

  it('keeps the historical Anthropic Bedrock payload settings', () => {
    const input = buildAbusivenessBedrockInvokeModelInput(
      'anthropic.test-model',
      'is this category okay?'
    );
    const body = JSON.parse(input.body as string) as Record<string, unknown>;

    expect(input.modelId).toBe('anthropic.test-model');
    expect(body).toMatchObject({
      temperature: 0.7,
      top_p: 0.8,
      top_k: 30
    });
  });
});
