import {
  buildReleaseNotesBedrockInvokeModelInput,
  DEFAULT_RELEASE_NOTES_BEDROCK_MODEL_ID,
  getReleaseNotesBedrockModelId,
  RELEASE_NOTES_BEDROCK_MODEL_ID_ENV,
  ReleaseNotesBedrockPrompter
} from './release-notes-bedrock.prompter';

describe('ReleaseNotesBedrockPrompter', () => {
  const originalModelId = process.env[RELEASE_NOTES_BEDROCK_MODEL_ID_ENV];

  afterEach(() => {
    if (originalModelId === undefined) {
      delete process.env[RELEASE_NOTES_BEDROCK_MODEL_ID_ENV];
    } else {
      process.env[RELEASE_NOTES_BEDROCK_MODEL_ID_ENV] = originalModelId;
    }
  });

  it('defaults to the same Claude Sonnet 4.5 inference profile as Help Bot', () => {
    delete process.env[RELEASE_NOTES_BEDROCK_MODEL_ID_ENV];

    expect(DEFAULT_RELEASE_NOTES_BEDROCK_MODEL_ID).toBe(
      'us.anthropic.claude-sonnet-4-5-20250929-v1:0'
    );
    expect(getReleaseNotesBedrockModelId()).toBe(
      DEFAULT_RELEASE_NOTES_BEDROCK_MODEL_ID
    );
  });

  it('uses the release-note-specific model override when configured', () => {
    process.env[RELEASE_NOTES_BEDROCK_MODEL_ID_ENV] =
      '  anthropic.release-notes-model  ';

    expect(getReleaseNotesBedrockModelId()).toBe(
      'anthropic.release-notes-model'
    );
  });

  it('uses a deterministic bounded Anthropic request', () => {
    const input = buildReleaseNotesBedrockInvokeModelInput(
      'anthropic.test-model',
      'Summarize these pull requests.'
    );
    const body = JSON.parse(input.body as string) as Record<string, unknown>;

    expect(input.modelId).toBe('anthropic.test-model');
    expect(body).toMatchObject({
      max_tokens: 8192,
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Summarize these pull requests.' }]
        }
      ]
    });
  });

  it('returns combined text from the Bedrock response', async () => {
    const send = jest.fn().mockResolvedValue({
      body: Buffer.from(
        JSON.stringify({
          content: [
            { type: 'text', text: '{"pull_requests":' },
            { type: 'text', text: '[]}' }
          ]
        })
      )
    });
    const prompter = new ReleaseNotesBedrockPrompter(
      'anthropic.test-model',
      () => ({ send }) as never,
      100
    );

    await expect(prompter.promptAndGetReply('prompt')).resolves.toBe(
      '{"pull_requests":[]}'
    );
    expect(send.mock.calls[0][1]?.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it('rejects an empty Bedrock response', async () => {
    const send = jest.fn().mockResolvedValue({
      body: Buffer.from(JSON.stringify({ content: [] }))
    });
    const prompter = new ReleaseNotesBedrockPrompter(
      'anthropic.test-model',
      () => ({ send }) as never,
      100
    );

    await expect(prompter.promptAndGetReply('prompt')).rejects.toThrow(
      'Unexpected empty response from Bedrock'
    );
  });
});
