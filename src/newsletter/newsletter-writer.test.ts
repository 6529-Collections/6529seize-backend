import {
  BedrockRuntimeClient,
  ConverseCommand
} from '@aws-sdk/client-bedrock-runtime';
import { NewsletterMaterial, NewsletterSource } from './newsletter-collector';
import { NewsletterWriter, sourceBatches } from './newsletter-writer';

const source = (index: number, text = 'A public story'): NewsletterSource => ({
  url: `https://6529.io/waves/public?serialNo=${index}`,
  discussion_start: `https://6529.io/waves/public?serialNo=${index}`,
  wave: 'Public',
  team_wave: false,
  author: 'Ayla',
  author_url: 'https://6529.io/Ayla',
  time: '2026-09-23T12:00:00Z',
  context_only: false,
  title: null,
  text: [text],
  quoted_messages: [],
  media: []
});
const material: NewsletterMaterial = {
  window: { start: '2026-09-23T00:00:00Z', end: '2026-09-24T00:00:00Z' },
  sources: [source(1)],
  winners: [],
  mints: []
};

describe('newsletter Bedrock writing', () => {
  const client = new BedrockRuntimeClient({ region: 'us-east-1' });
  afterEach(() => jest.restoreAllMocks());

  it('uses one editorial call for ordinary volumes with public material only', async () => {
    const send = jest.spyOn(client, 'send').mockResolvedValue({
      stopReason: 'end_turn',
      output: { message: { content: [{ text: 'The edition' }] } }
    } as never);
    expect(await new NewsletterWriter('model', client).write(material)).toBe(
      'The edition'
    );
    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0][0] as ConverseCommand;
    expect(command.input.modelId).toBe('model');
    expect(JSON.parse(command.input.messages![0].content![0].text!)).toEqual(
      material
    );
    expect(command.input.system![0].text).toContain('EVERY occurrence');
  });

  it.each(['max_tokens', 'content_filtered', 'guardrail_intervened'])(
    'does not publish an incomplete response (%s)',
    async (stopReason) => {
      jest.spyOn(client, 'send').mockResolvedValue({
        stopReason,
        output: { message: { content: [{ text: 'Partial' }] } }
      } as never);
      await expect(
        new NewsletterWriter('model', client).write(material)
      ).rejects.toThrow('did not finish');
    }
  );

  it('selects from every large-day batch and retains mandatory event facts in the final call', async () => {
    const large: NewsletterMaterial = {
      ...material,
      sources: Array.from({ length: 10 }, (_, i) =>
        source(i, 'x'.repeat(100_000))
      ),
      winners: [
        {
          author: 'Ayla',
          author_url: 'https://6529.io/Ayla',
          title: 'Winning Art',
          url: 'https://6529.io/waves/stage?serialNo=10',
          decision_time: '2026-09-23T12:00:00Z',
          ranking: 1
        }
      ]
    };
    const batches = sourceBatches(large.sources);
    expect(batches.flat()).toEqual(large.sources);
    const send = jest.spyOn(client, 'send').mockResolvedValue({
      stopReason: 'end_turn',
      output: { message: { content: [{ text: 'Editorial brief' }] } }
    } as never);
    await new NewsletterWriter('model', client).write(large);
    expect(send).toHaveBeenCalledTimes(batches.length + 1);
    const inputs = send.mock.calls.map(([command]) =>
      JSON.parse(
        (command as ConverseCommand).input.messages![0].content![0].text!
      )
    );
    expect(inputs.slice(0, -1).flatMap((input) => input.sources)).toEqual(
      large.sources
    );
    expect(inputs.at(-1).winners).toEqual(large.winners);
    expect(inputs.at(-1).editorial_briefs).toHaveLength(batches.length);
  });

  it('rejects unmanageable source volume instead of silently omitting messages', () => {
    expect(() => sourceBatches([source(1, 'x'.repeat(400_000))])).toThrow(
      'source exceeds'
    );
    expect(() =>
      sourceBatches(
        Array.from({ length: 25 }, (_, i) => source(i, 'x'.repeat(250_000)))
      )
    ).toThrow('refusing incomplete coverage');
  });
});
