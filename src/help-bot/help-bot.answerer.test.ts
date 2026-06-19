import { HelpBotAnswerer, HelpBotLlmRenderer } from './help-bot.answerer';

const BASE_URL = 'https://6529.io';

describe('HelpBotAnswerer', () => {
  it('returns a deterministic answer for seeded knowledge', async () => {
    const answer = await new HelpBotAnswerer().answer({
      question: 'what is TDH?',
      baseUrl: BASE_URL
    });

    expect(answer.type).toBe('ANSWER');
    if (answer.type === 'ANSWER') {
      expect(answer.answer).toContain('TDH stands for Total Days Held.');
      expect(answer.answer).toContain('https://6529.io/network/tdh');
      expect(answer.record.id).toBe('tdh');
    }
  });

  it('uses previous bot answer as context for follow-up questions', async () => {
    const answer = await new HelpBotAnswerer().answer({
      question: 'what about eligibility?',
      previousBotAnswer:
        'Subscription Minting is an optional way to mint Meme Cards remotely.',
      baseUrl: BASE_URL
    });

    expect(answer.type).toBe('ANSWER');
    if (answer.type === 'ANSWER') {
      expect(answer.record.id).toBe('subscription-eligibility');
      expect(answer.answer).toContain(
        'Subscriptions do not create extra eligibility.'
      );
    }
  });

  it('returns no reliable source for unseeded questions', async () => {
    await expect(
      new HelpBotAnswerer().answer({
        question: 'what is the lunch menu today?',
        baseUrl: BASE_URL
      })
    ).resolves.toEqual({ type: 'NO_RELIABLE_SOURCE' });
  });

  it('uses an LLM renderer and appends the canonical URL when missing', async () => {
    const renderer: HelpBotLlmRenderer = {
      renderAnswer: jest.fn().mockResolvedValue('TDH is Total Days Held.')
    };

    const answer = await new HelpBotAnswerer(renderer).answer({
      question: 'what is TDH?',
      baseUrl: BASE_URL
    });

    expect(renderer.renderAnswer).toHaveBeenCalledTimes(1);
    expect(answer.type).toBe('ANSWER');
    if (answer.type === 'ANSWER') {
      expect(answer.answer).toBe(
        'TDH is Total Days Held.\n\nMore info: https://6529.io/network/tdh'
      );
    }
  });

  it('falls back to deterministic answers when the renderer fails', async () => {
    const renderer: HelpBotLlmRenderer = {
      renderAnswer: jest.fn().mockRejectedValue(new Error('bedrock down'))
    };

    const answer = await new HelpBotAnswerer(renderer).answer({
      question: 'how do I create a wave?',
      baseUrl: BASE_URL
    });

    expect(answer.type).toBe('ANSWER');
    if (answer.type === 'ANSWER') {
      expect(answer.record.id).toBe('create-wave');
      expect(answer.answer).toContain('https://6529.io/waves/create');
    }
  });
});
