import { ContentReportReason } from '@/entities/IContentModeration';
import { TextEncoder } from 'node:util';
import { ContentModerationAiService } from './content-moderation-ai.service';

function createService(response: Record<string, unknown>) {
  const send = jest.fn().mockResolvedValue({
    body: new TextEncoder().encode(
      JSON.stringify({ content: [{ text: JSON.stringify(response) }] })
    )
  });
  return {
    send,
    service: new ContentModerationAiService(() => ({ send }) as any)
  };
}

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

  it('instructs pre-publication evaluation to distinguish test cards from claimed real card data', async () => {
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
      'payment-card number presented as genuine financial information'
    );
    expect(prompt).toContain(
      'even when the submitter claims that the number is their own'
    );
    expect(prompt).toContain(
      'Allow a widely documented sandbox or test number only when the surrounding content clearly identifies it as test, sandbox, example, or documentation data.'
    );
    expect(prompt).toContain(
      '"This is my Mastercard number: 4242 4242 4242 4242" is REJECT with category SENSITIVE_PRIVATE_INFORMATION'
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
});
