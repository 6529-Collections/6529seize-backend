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
                queryId: 'memes_in_season_count',
                params: { season: 1 }
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
      queryId: 'memes_in_season_count',
      params: { season: 1 }
    });
  });
});
