import fc from 'fast-check';
import { TextEncoder } from 'node:util';
import {
  BedrockAnthropicRefusalError,
  buildBedrockAnthropicBody,
  isPre46ClaudeModel,
  parseBedrockAnthropicReply
} from './bedrock-anthropic';

function encode(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

describe('bedrock anthropic helpers', () => {
  it.each([
    'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
    'global.anthropic.claude-haiku-4-5-20251001-v1:0',
    'us.anthropic.claude-opus-4-1-20250805-v1:0',
    'us.anthropic.claude-sonnet-4-20250514-v1:0',
    'us.anthropic.claude-3-haiku-20240307-v1:0',
    'anthropic.claude-haiku-4-5'
  ])('treats %s as a pre-4.6 sampling model', (modelId) => {
    expect(isPre46ClaudeModel(modelId)).toBe(true);
  });

  it.each([
    'us.anthropic.claude-sonnet-5-5',
    'us.anthropic.claude-haiku-5-5',
    'us.anthropic.claude-sonnet-4-6',
    'us.anthropic.claude-opus-4-6-v1',
    'us.anthropic.claude-sonnet-4-6-20260101-v1:0',
    'us.anthropic.claude-opus-4-7-20260301-v1:0',
    'global.anthropic.claude-opus-5-5',
    'anthropic.test-model'
  ])('treats %s as an effort model', (modelId) => {
    expect(isPre46ClaudeModel(modelId)).toBe(false);
  });

  it('sends only legacy sampling parameters to pre-4.6 models', () => {
    const body = JSON.parse(
      buildBedrockAnthropicBody({
        modelId: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
        prompt: 'hello',
        maxTokens: 100,
        effort: 'low',
        jsonSchema: { type: 'object' },
        legacySampling: { temperature: 0, top_k: 1 }
      })
    );

    expect(body).toEqual({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 100,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      temperature: 0,
      top_k: 1
    });
  });

  it('sends effort and the JSON schema to newer models', () => {
    const body = JSON.parse(
      buildBedrockAnthropicBody({
        modelId: 'us.anthropic.claude-sonnet-5-5',
        prompt: 'hello',
        maxTokens: 100,
        effort: 'low',
        system: 'system prompt',
        jsonSchema: { type: 'object' },
        legacySampling: { temperature: 0, top_k: 1 }
      })
    );

    expect(body).toEqual({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 100,
      system: 'system prompt',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      thinking: { type: 'adaptive' },
      output_config: {
        effort: 'low',
        format: { type: 'json_schema', schema: { type: 'object' } }
      }
    });
  });

  it('never sends sampling parameters or prefill to newer models', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          'us.anthropic.claude-sonnet-5-5',
          'us.anthropic.claude-haiku-5-5',
          'us.anthropic.claude-opus-5-5',
          'us.anthropic.claude-sonnet-4-6',
          'us.anthropic.claude-opus-4-8'
        ),
        fc.string(),
        fc.integer({ min: 1, max: 64_000 }),
        fc.constantFrom('low', 'medium', 'high') as fc.Arbitrary<
          'low' | 'medium' | 'high'
        >,
        (modelId, prompt, maxTokens, effort) => {
          const body = JSON.parse(
            buildBedrockAnthropicBody({
              modelId,
              prompt,
              maxTokens,
              effort,
              legacySampling: { temperature: 0.7, top_k: 30 }
            })
          );
          expect(body).not.toHaveProperty('temperature');
          expect(body).not.toHaveProperty('top_k');
          expect(body.thinking).toEqual({ type: 'adaptive' });
          expect(body.output_config).toEqual({ effort });
          expect(body.messages).toHaveLength(1);
          expect(body.messages[0].role).toBe('user');
        }
      )
    );
  });

  it('reads text blocks by type after thinking blocks', () => {
    expect(
      parseBedrockAnthropicReply(
        encode({
          content: [
            { type: 'thinking', thinking: '', signature: 'sig' },
            { type: 'text', text: '{"value":' },
            { type: 'text', text: '"Allowed"}' }
          ],
          stop_reason: 'end_turn'
        })
      )
    ).toMatchObject({ text: '{"value":"Allowed"}', stopReason: 'end_turn' });
  });

  it('returns empty text when only thinking was produced', () => {
    expect(
      parseBedrockAnthropicReply(
        encode({
          content: [{ type: 'thinking', thinking: '', signature: 'sig' }],
          stop_reason: 'max_tokens'
        })
      )
    ).toMatchObject({ text: '', stopReason: 'max_tokens' });
  });

  it('raises a typed error for refusals', () => {
    const parse = () =>
      parseBedrockAnthropicReply(
        encode({
          content: [],
          stop_reason: 'refusal',
          stop_details: { type: 'refusal', category: 'general_harms' }
        })
      );

    expect(parse).toThrow(BedrockAnthropicRefusalError);
    expect(parse).toThrow('Bedrock model declined the request (general_harms)');
  });
});
