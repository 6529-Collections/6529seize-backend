import { ContentReportReason } from '@/entities/IContentModeration';
import { TextEncoder } from 'node:util';
import { ContentModerationAiService } from './content-moderation-ai.service';

function createServiceWithBody(body: Record<string, unknown>) {
  const send = jest.fn().mockResolvedValue({
    body: new TextEncoder().encode(JSON.stringify(body))
  });
  return {
    send,
    service: new ContentModerationAiService(() => ({ send }) as any)
  };
}

function createService(response: Record<string, unknown>) {
  return createServiceWithBody({
    content: [{ type: 'text', text: JSON.stringify(response) }],
    stop_reason: 'end_turn'
  });
}

function readRequestBody(send: jest.Mock): Record<string, unknown> {
  return JSON.parse(send.mock.calls[0]?.[0].input.body) as Record<
    string,
    unknown
  >;
}

const ALLOWED_REPORT = {
  recommendation: 'NO_VIOLATION_DETECTED',
  category: 'NONE',
  confidence: 0.1,
  rationale: 'Allowed',
  evidence: []
};

describe('ContentModerationAiService', () => {
  const originalModelId = process.env.CONTENT_MODERATION_BEDROCK_MODEL_ID;

  afterEach(() => {
    if (originalModelId === undefined) {
      delete process.env.CONTENT_MODERATION_BEDROCK_MODEL_ID;
    } else {
      process.env.CONTENT_MODERATION_BEDROCK_MODEL_ID = originalModelId;
    }
  });

  it('accepts only policy-defined categories from the model', async () => {
    const { service } = createService({
      recommendation: 'URGENT_QUARANTINE',
      category: 'MODEL_INVENTED_CATEGORY',
      confidence: 0.99,
      rationale: 'Model supplied text',
      evidence: []
    });

    await expect(
      service.assessReportedContent({
        reason: ContentReportReason.OTHER,
        content: { text: 'reported content' }
      })
    ).rejects.toThrow('AI response category is invalid');
  });

  it('applies the category allowlist to pre-publication assessments', async () => {
    const { service } = createService({
      outcome: 'REJECT',
      category: 'MODEL_INVENTED_CATEGORY',
      confidence: 0.99,
      rationale: 'Model supplied text'
    });

    await expect(
      service.assessPrePublication({
        signal: 'EXPLICIT_THREAT_PATTERN',
        content: 'submitted content'
      })
    ).rejects.toThrow('AI response category is invalid');
  });

  it('instructs pre-publication evaluation to distinguish example data from genuine structured private data', async () => {
    const { send, service } = createService({
      outcome: 'ALLOW',
      category: 'NONE',
      confidence: 0.99,
      rationale: 'Clearly labelled test data'
    });

    await service.assessPrePublication({
      signal: 'STRUCTURED_SENSITIVE_DATA',
      content: 'Stripe sandbox test card: 4242 4242 4242 4242'
    });

    const requestBody = JSON.parse(send.mock.calls[0]?.[0].input.body) as {
      readonly messages: ReadonlyArray<{
        readonly content: ReadonlyArray<{ readonly text: string }>;
      }>;
    };
    const prompt = requestBody.messages[0]?.content[0]?.text;

    expect(prompt).toContain(
      'genuine, usable private data, whether it belongs to the submitter or another person'
    );
    expect(prompt).toContain(
      'fictitious, sandbox, test, example, redacted, or documentation data'
    );
    expect(prompt).toContain(
      "An ownership claim or a value's known test status is context only"
    );
    expect(prompt).toContain(
      '"This is my Mastercard number: 4242 4242 4242 4242" is REJECT with category SENSITIVE_PRIVATE_INFORMATION'
    );
    expect(prompt).toContain(
      '"Documentation example SSN: 123-45-6789" is ALLOW'
    );
    expect(prompt).toContain(
      '"My SSN is 123-45-6789" is REJECT with category SENSITIVE_PRIVATE_INFORMATION'
    );
    expect(prompt).toContain(
      'Untrusted submission: "Stripe sandbox test card: 4242 4242 4242 4242"'
    );
  });

  it('accepts a defined category with a valid recommendation', async () => {
    const { service } = createService({
      recommendation: 'NEEDS_HUMAN_REVIEW',
      category: 'TARGETED_HARASSMENT',
      confidence: 0.8,
      rationale: 'Context should be reviewed',
      evidence: []
    });

    await expect(
      service.assessReportedContent({
        reason: ContentReportReason.THREATS_OR_TARGETED_HARASSMENT,
        content: { text: 'reported content' }
      })
    ).resolves.toMatchObject({ category: 'TARGETED_HARASSMENT' });
  });

  it('rejects NONE when reported content needs review', async () => {
    const { service } = createService({
      recommendation: 'NEEDS_HUMAN_REVIEW',
      category: 'NONE',
      confidence: 0.8,
      rationale: 'Context should be reviewed',
      evidence: []
    });

    await expect(
      service.assessReportedContent({
        reason: ContentReportReason.OTHER,
        content: { text: 'reported content' }
      })
    ).rejects.toThrow('AI response category conflicts with recommendation');
  });

  it('rejects a violation category when reported content is cleared', async () => {
    const { service } = createService({
      recommendation: 'NO_VIOLATION_DETECTED',
      category: 'SCAM_OR_PHISHING',
      confidence: 0.9,
      rationale: 'No violation',
      evidence: []
    });

    await expect(
      service.assessReportedContent({
        reason: ContentReportReason.SCAM_OR_PHISHING,
        content: { text: 'ordinary content' }
      })
    ).rejects.toThrow('AI response category conflicts with recommendation');
  });

  it('requires NONE for allowed pre-publication content', async () => {
    const { service } = createService({
      outcome: 'ALLOW',
      category: 'SENSITIVE_PRIVATE_INFORMATION',
      confidence: 0.7,
      rationale: 'Allow'
    });

    await expect(
      service.assessPrePublication({
        signal: 'STRUCTURED_SENSITIVE_DATA',
        content: 'example data'
      })
    ).rejects.toThrow('AI response category conflicts with outcome');
  });

  it('resolves the configured model after runtime secrets are loaded', async () => {
    const { send, service } = createService({
      recommendation: 'NO_VIOLATION_DETECTED',
      category: 'NONE',
      confidence: 0.1,
      rationale: 'Allowed',
      evidence: []
    });
    process.env.CONTENT_MODERATION_BEDROCK_MODEL_ID = 'runtime-model-id';

    await service.assessReportedContent({
      reason: ContentReportReason.OTHER,
      content: { text: 'ordinary content' }
    });

    expect(send.mock.calls[0]?.[0].input.modelId).toBe('runtime-model-id');
    expect(send.mock.calls[0]?.[1]?.abortSignal).toBeInstanceOf(AbortSignal);
  });
  it('defaults to Claude Sonnet 5.5 with low effort and a JSON schema', async () => {
    delete process.env.CONTENT_MODERATION_BEDROCK_MODEL_ID;
    const { send, service } = createService(ALLOWED_REPORT);

    await service.assessReportedContent({
      reason: ContentReportReason.OTHER,
      content: { text: 'ordinary content' }
    });

    expect(send.mock.calls[0]?.[0].input.modelId).toBe(
      'us.anthropic.claude-sonnet-5-5'
    );
    const body = readRequestBody(send);
    expect(body).toMatchObject({
      output_config: {
        effort: 'low',
        format: {
          type: 'json_schema',
          schema: {
            required: expect.arrayContaining(['recommendation', 'category']),
            additionalProperties: false
          }
        }
      }
    });
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('top_k');
  });

  it('defaults pre-publication checks to Sonnet 5.5 with the outcome schema', async () => {
    delete process.env.CONTENT_MODERATION_BEDROCK_MODEL_ID;
    const { send, service } = createService({
      outcome: 'ALLOW',
      category: 'NONE',
      confidence: 0.99,
      rationale: 'Clearly labelled test data'
    });

    await service.assessPrePublication({
      signal: 'STRUCTURED_SENSITIVE_DATA',
      content: 'Stripe sandbox test card: 4242 4242 4242 4242'
    });

    expect(send.mock.calls[0]?.[0].input.modelId).toBe(
      'us.anthropic.claude-sonnet-5-5'
    );
    expect(readRequestBody(send)).toMatchObject({
      output_config: {
        effort: 'low',
        format: {
          schema: {
            properties: { outcome: { enum: ['ALLOW', 'REJECT'] } }
          }
        }
      }
    });
  });

  it('keeps the Sonnet 4.5 deterministic payload for a rollback override', async () => {
    process.env.CONTENT_MODERATION_BEDROCK_MODEL_ID =
      'us.anthropic.claude-sonnet-4-5-20250929-v1:0';
    const { send, service } = createService(ALLOWED_REPORT);

    await service.assessReportedContent({
      reason: ContentReportReason.OTHER,
      content: { text: 'ordinary content' }
    });

    expect(send.mock.calls[0]?.[0].input.modelId).toBe(
      'us.anthropic.claude-sonnet-4-5-20250929-v1:0'
    );
    const body = readRequestBody(send);
    expect(body).toMatchObject({ temperature: 0, top_k: 1 });
    expect(body).not.toHaveProperty('output_config');
  });

  it('reads the assessment from the text block after a thinking block', async () => {
    const { service } = createServiceWithBody({
      content: [
        { type: 'thinking', thinking: '', signature: 'sig' },
        { type: 'text', text: JSON.stringify(ALLOWED_REPORT) }
      ],
      stop_reason: 'end_turn'
    });

    await expect(
      service.assessReportedContent({
        reason: ContentReportReason.OTHER,
        content: { text: 'ordinary content' }
      })
    ).resolves.toMatchObject({ category: 'NONE' });
  });

  it('treats a model refusal as an evaluator failure', async () => {
    const { service } = createServiceWithBody({
      content: [],
      stop_reason: 'refusal',
      stop_details: { type: 'refusal', category: 'general_harms' }
    });

    await expect(
      service.assessPrePublication({
        signal: 'EXPLICIT_THREAT_PATTERN',
        content: 'submitted content'
      })
    ).rejects.toThrow('Bedrock model declined the request (general_harms)');
  });

  it('treats a truncated assessment as an evaluator failure', async () => {
    const { service } = createServiceWithBody({
      content: [{ type: 'text', text: '{"outcome":"ALLOW","category":' }],
      stop_reason: 'max_tokens'
    });

    await expect(
      service.assessPrePublication({
        signal: 'EXPLICIT_THREAT_PATTERN',
        content: 'submitted content'
      })
    ).rejects.toThrow('Moderation evaluator response was truncated');
  });
});
