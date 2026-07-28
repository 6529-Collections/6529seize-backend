import { HelpBotBedrockRenderer } from './help-bot.bedrock-renderer';
import { HelpBotKnowledgeRecord } from './help-bot.knowledge';

const RECORD: HelpBotKnowledgeRecord = {
  id: 'network.tdh',
  kind: 'glossary',
  title: 'TDH',
  linkLabel: 'TDH page',
  canonicalPath: '/network/tdh',
  aliases: ['tdh'],
  keywords: ['tdh'],
  facts: ['TDH stands for Total Days Held.'],
  relatedPaths: [],
  tags: [],
  sourceRefs: []
};

describe('HelpBotBedrockRenderer', () => {
  function readBody(send: jest.Mock): Record<string, unknown> {
    const command = send.mock.calls[0][0] as {
      readonly input?: { readonly body?: string };
    };
    return JSON.parse(command.input?.body ?? '{}') as Record<string, unknown>;
  }

  function readPrompt(send: jest.Mock): string {
    const body = readBody(send) as {
      readonly messages?: Array<{
        readonly content?: Array<{ readonly text?: string }>;
      }>;
    };
    return body.messages?.[0]?.content?.[0]?.text ?? '';
  }

  it('renders text from an Anthropic Bedrock response', async () => {
    const send = jest.fn().mockResolvedValue({
      body: Buffer.from(
        JSON.stringify({
          content: [{ type: 'text', text: 'TDH is Total Days Held.' }]
        })
      )
    });
    const renderer = new HelpBotBedrockRenderer(
      'anthropic.test-model',
      () => ({ send }) as never,
      100
    );

    await expect(
      renderer.renderAnswer({
        question: 'what is tdh?',
        record: RECORD,
        canonicalUrl: 'https://6529.io/network/tdh'
      })
    ).resolves.toBe('TDH is Total Days Held.');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1]?.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it('sends Anthropic Bedrock payloads without top_p', async () => {
    const send = jest.fn().mockResolvedValue({
      body: Buffer.from(
        JSON.stringify({
          content: [{ type: 'text', text: 'TDH is Total Days Held.' }]
        })
      )
    });
    const renderer = new HelpBotBedrockRenderer(
      'anthropic.test-model',
      () => ({ send }) as never,
      100
    );

    await renderer.renderAnswer({
      question: 'what is tdh?',
      record: RECORD,
      canonicalUrl: 'https://6529.io/network/tdh'
    });

    expect(readBody(send)).toMatchObject({
      temperature: 0.2,
      top_k: 20
    });
    expect(readBody(send)).not.toHaveProperty('top_p');
  });

  it('includes bounded tone guidance in natural answer prompts', async () => {
    const send = jest.fn().mockResolvedValue({
      body: Buffer.from(
        JSON.stringify({
          content: [{ type: 'text', text: 'TDH is Total Days Held.' }]
        })
      )
    });
    const renderer = new HelpBotBedrockRenderer(
      'anthropic.test-model',
      () => ({ send }) as never,
      100
    );

    await renderer.renderAnswer({
      question: 'explain tdh to me bru',
      record: RECORD,
      canonicalUrl: 'https://6529.io/network/tdh'
    });

    expect(readPrompt(send)).toContain('Mirror the user tone lightly');
    expect(readPrompt(send)).toContain('Do not invent details');
    expect(readPrompt(send)).toContain('Do not begin with @help6529');
    expect(readPrompt(send)).toContain('Do not print a bare URL');
    expect(readPrompt(send)).toContain(
      'Include this URL exactly once as a Markdown link target: https://6529.io/network/tdh'
    );
    expect(readPrompt(send)).toContain(
      'Use this exact Markdown link label for that URL: TDH page'
    );
  });

  it('does not require source links for records that suppress them', async () => {
    const send = jest.fn().mockResolvedValue({
      body: Buffer.from(
        JSON.stringify({
          content: [{ type: 'text', text: 'Use the profile menu.' }]
        })
      )
    });
    const renderer = new HelpBotBedrockRenderer(
      'anthropic.test-model',
      () => ({ send }) as never,
      100
    );

    await renderer.renderAnswer({
      question: 'how do i share connection?',
      record: {
        ...RECORD,
        id: 'wallet.connection-sharing',
        title: 'Connection sharing',
        linkLabel: 'Connection sharing',
        canonicalPath: '/',
        suppressSourceLinks: true,
        aliases: ['share connection'],
        keywords: ['share', 'connection'],
        facts: ['Use the profile menu to open the Share menu.']
      },
      canonicalUrl: 'https://6529.io/'
    });

    expect(readPrompt(send)).toContain(
      'Do not include source links unless the provided facts explicitly require one.'
    );
    expect(readPrompt(send)).not.toContain(
      'Include this URL exactly once as a Markdown link target'
    );
    expect(readPrompt(send)).not.toContain(
      'Use this exact Markdown link label for that URL'
    );
  });

  it('adds strict versioned grounding rules for Stream evidence packets', async () => {
    const send = jest.fn().mockResolvedValue({
      body: Buffer.from(
        JSON.stringify({
          content: [{ type: 'text', text: 'The function takes no inputs.' }]
        })
      )
    });
    const renderer = new HelpBotBedrockRenderer(
      'anthropic.test-model',
      () => ({ send }) as never,
      100
    );

    await renderer.renderAnswer({
      question: 'what inputs does withdrawBidderCredit take?',
      record: {
        ...RECORD,
        id: '6529-stream@2026-07-27.1',
        kind: 'public_review_knowledge',
        title: '6529 Stream review evidence (2026-07-27.1)',
        linkLabel: '6529 Stream Review',
        canonicalPath: '/reviews/6529-stream/versions/2026-07-27.1',
        facts: [
          'Corpus identity: version 2026-07-27.1.',
          '{"scope":"protocol","technical":{"declaration":{"inputs":[]}}}'
        ]
      },
      canonicalUrl: 'https://6529.io/reviews/6529-stream/versions/2026-07-27.1'
    });

    const prompt = readPrompt(send);
    expect(prompt).toContain(
      'Treat structured technical fields as more authoritative'
    );
    expect(prompt).toContain(
      'Distinguish protocol code from scripts, tests, dependencies'
    );
    expect(prompt).toContain(
      'Do not infer exact inputs, outputs, caller authorization'
    );
    expect(prompt).toContain(
      'If an AMBIGUITY fact is present, clearly ask for the contract'
    );
    expect(prompt).toContain('Mention the review version');
  });

  it('aborts a slow Bedrock response', async () => {
    const send = jest.fn(
      (
        _command,
        options: {
          readonly abortSignal: AbortSignal;
        }
      ) =>
        new Promise((_resolve, reject) => {
          options.abortSignal.addEventListener('abort', () =>
            reject(new Error('aborted'))
          );
        })
    );
    const renderer = new HelpBotBedrockRenderer(
      'anthropic.test-model',
      () => ({ send }) as never,
      1
    );

    await expect(
      renderer.renderAnswer({
        question: 'what is tdh?',
        record: RECORD,
        canonicalUrl: 'https://6529.io/network/tdh'
      })
    ).rejects.toThrow('aborted');
  });

  it('parses public data query intents from JSON', async () => {
    const send = jest.fn().mockResolvedValue({
      body: Buffer.from(
        JSON.stringify({
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                entity: 'meme_cards',
                operation: 'count',
                metric: null,
                filters: { season: 1 },
                limit: 1
              })
            }
          ]
        })
      )
    });
    const renderer = new HelpBotBedrockRenderer(
      'anthropic.test-model',
      () => ({ send }) as never,
      100
    );

    await expect(
      renderer.planPublicDataQuery({
        question: 'how many memes are in szn1?',
        catalog: 'catalog'
      })
    ).resolves.toEqual({
      entity: 'meme_cards',
      operation: 'count',
      metric: null,
      filters: { season: 1 },
      limit: 1
    });
  });

  it('aborts a slow public-data planning response', async () => {
    const send = jest.fn(
      (
        _command,
        options: {
          readonly abortSignal: AbortSignal;
        }
      ) =>
        new Promise((_resolve, reject) => {
          options.abortSignal.addEventListener('abort', () =>
            reject(new Error('aborted'))
          );
        })
    );
    const renderer = new HelpBotBedrockRenderer(
      'anthropic.test-model',
      () => ({ send }) as never,
      1
    );

    await expect(
      renderer.planPublicDataQuery({
        question: 'how many memes are in szn1?',
        catalog: 'catalog'
      })
    ).rejects.toThrow('aborted');
  });
});
