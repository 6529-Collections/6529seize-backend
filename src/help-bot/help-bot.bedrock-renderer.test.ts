import { HelpBotBedrockRenderer } from './help-bot.bedrock-renderer';
import { HelpBotKnowledgeRecord } from './help-bot.knowledge';

const RECORD: HelpBotKnowledgeRecord = {
  id: 'network.tdh',
  kind: 'glossary',
  title: 'TDH',
  canonicalPath: '/network/tdh',
  aliases: ['tdh'],
  keywords: ['tdh'],
  facts: ['TDH stands for Total Days Held.'],
  relatedPaths: [],
  tags: [],
  sourceRefs: []
};

describe('HelpBotBedrockRenderer', () => {
  function readPrompt(send: jest.Mock): string {
    const command = send.mock.calls[0][0] as {
      readonly input?: { readonly body?: string };
    };
    const body = JSON.parse(command.input?.body ?? '{}') as {
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
    expect(readPrompt(send)).toContain('Do not begin with @6529help');
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
