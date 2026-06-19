import { HelpBotAnswerer, HelpBotLlmRenderer } from './help-bot.answerer';
import {
  HelpBotKnowledgeIndex,
  StaticHelpBotKnowledgeSource
} from './help-bot.knowledge';

const BASE_URL = 'https://6529.io';
const TEST_INDEX: HelpBotKnowledgeIndex = {
  schemaVersion: 1,
  generatedAt: '2026-06-19T00:00:00.000Z',
  commitSha: 'test',
  baseUrl: BASE_URL,
  records: [
    {
      id: 'network.tdh',
      kind: 'glossary',
      title: 'TDH',
      canonicalPath: '/network/tdh',
      aliases: ['tdh', 'total days held'],
      keywords: ['tdh', 'total', 'days', 'held'],
      facts: ['TDH stands for Total Days Held.'],
      relatedPaths: [],
      tags: ['network'],
      sourceRefs: []
    },
    {
      id: 'waves.create.entrypoint.sidebar',
      kind: 'ui_affordance',
      title: 'Create a wave',
      canonicalPath: '/waves/create',
      aliases: ['create wave', 'make a wave', 'new wave'],
      keywords: ['create', 'wave', 'waves', 'plus'],
      facts: ['Use the plus button in the Waves left sidebar.'],
      relatedPaths: [],
      tags: ['waves'],
      sourceRefs: []
    },
    {
      id: 'subscriptions.eligibility',
      kind: 'workflow',
      title: 'Subscription eligibility',
      canonicalPath: '/about/subscriptions',
      aliases: ['subscription eligibility', 'eligibility'],
      keywords: ['subscription', 'subscriptions', 'eligibility', 'allowlist'],
      facts: ['Subscriptions do not create extra eligibility.'],
      relatedPaths: [],
      tags: ['subscriptions'],
      sourceRefs: []
    }
  ]
};

function answerer(renderer?: HelpBotLlmRenderer): HelpBotAnswerer {
  return new HelpBotAnswerer(
    renderer,
    new StaticHelpBotKnowledgeSource(TEST_INDEX)
  );
}

describe('HelpBotAnswerer', () => {
  it('returns a deterministic answer for frontend-index knowledge', async () => {
    const answer = await answerer().answer({
      question: 'what is TDH?',
      baseUrl: BASE_URL
    });

    expect(answer.type).toBe('ANSWER');
    if (answer.type === 'ANSWER') {
      expect(answer.answer).toContain('TDH stands for Total Days Held.');
      expect(answer.answer).toContain('https://6529.io/network/tdh');
      expect(answer.record.id).toBe('network.tdh');
    }
  });

  it('uses previous bot answer as context for follow-up questions', async () => {
    const answer = await answerer().answer({
      question: 'what about eligibility?',
      previousBotAnswer:
        'Subscription Minting is an optional way to mint Meme Cards remotely.',
      baseUrl: BASE_URL
    });

    expect(answer.type).toBe('ANSWER');
    if (answer.type === 'ANSWER') {
      expect(answer.record.id).toBe('subscriptions.eligibility');
      expect(answer.answer).toContain(
        'Subscriptions do not create extra eligibility.'
      );
    }
  });

  it('returns no reliable source for unindexed questions', async () => {
    await expect(
      answerer().answer({
        question: 'what is the lunch menu today?',
        baseUrl: BASE_URL
      })
    ).resolves.toEqual({ type: 'NO_RELIABLE_SOURCE' });
  });

  it('uses an LLM renderer and appends the canonical URL when missing', async () => {
    const renderer: HelpBotLlmRenderer = {
      renderAnswer: jest.fn().mockResolvedValue('TDH is Total Days Held.')
    };

    const answer = await answerer(renderer).answer({
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

    const answer = await answerer(renderer).answer({
      question: 'how do I create a wave?',
      baseUrl: BASE_URL
    });

    expect(answer.type).toBe('ANSWER');
    if (answer.type === 'ANSWER') {
      expect(answer.record.id).toBe('waves.create.entrypoint.sidebar');
      expect(answer.answer).toContain('https://6529.io/waves/create');
    }
  });
});
