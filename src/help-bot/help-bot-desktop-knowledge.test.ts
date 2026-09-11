import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HelpBotAnswerer } from './help-bot.answerer';
import { FrontendHelpBotKnowledgeSource } from './help-bot.knowledge';
import { HelpBotPublicDataService } from './help-bot-public-data.service';
import { HelpBotCalendarService } from './help-bot-calendar.service';
import { HelpBotStreamKnowledgeSource } from './help-bot-stream-knowledge';
import {
  desktopQuestionWithContext,
  MAX_DESKTOP_ANSWER_CHARACTERS
} from './help-bot-desktop-knowledge';

// Snapshot of frontend-owned records, including competing web/mobile topics.
// An optional full corpus path also exercises the exact companion FE artifact locally.
const corpus = readFileSync(
  process.env.HELP_BOT_TEST_CORPUS_PATH ??
    join(__dirname, 'fixtures/desktop-help-index.json'),
  'utf8'
);
const source = () =>
  new FrontendHelpBotKnowledgeSource(async () => ({
    ok: true,
    status: 200,
    text: async () => corpus
  }));

describe('Desktop corpus retrieval and answers', () => {
  const cases = [
    ['how to get started with 6529 desktop app', 'getting-started'],
    ['how do I get started in Core?', 'getting-started'],
    ['explain Core in depth', 'getting-started'],
    ['how does 6529 desktop work?', 'getting-started'],
    ['my tdh in desktop app is out of sync what can i do', 'tdh-out-of-sync'],
    ['why is my Desktop app total TDH different?', 'tdh-out-of-sync'],
    ['how do I enable RPC providers in Core?', 'rpc-providers'],
    ['why does my Core RPC say Invalid RPC URL?', 'rpc-providers'],
    ['how do Core workers run automatically?', 'workers'],
    [
      'when does the desktop app calculate TDH automatically?',
      'tdh-calculation'
    ],
    ['what does TestNet Mode Phase 1 mean in 6529 Desktop?', 'tdh-calculation'],
    ['how do I reconcile transactions in Core?', 'transaction-reconciliation'],
    ['how do I reset trx worker in Core?', 'transaction-reset'],
    ['how do I rebuild ownership in Core?', 'transaction-reset'],
    ['how do I do nfts full recovery in Core?', 'nft-recovery'],
    ['how do I import a Core wallet?', 'wallets'],
    ['I forgot my Core wallet password', 'wallet-backup'],
    ['how do I download a Core recovery file?', 'wallet-backup'],
    ['what is My IPFS in 6529 Desktop?', 'ipfs'],
    ['where are the desktop app logs and version?', 'about-and-logs'],
    ['how do I search local transactions in Core?', 'local-data']
  ];

  it.each(cases)('routes "%s" to desktop.%s', async (question, id) => {
    expect((await source().findMatch(question))?.record.id).toBe(
      `desktop.${id}`
    );
  });

  function makeAnswerer(renderer: null | { renderAnswer: jest.Mock } = null) {
    const publicAnswer = jest.fn();
    const answerer = new HelpBotAnswerer(
      renderer,
      source(),
      { answer: publicAnswer } as unknown as HelpBotPublicDataService,
      {
        answer: jest.fn().mockResolvedValue(null)
      } as unknown as HelpBotCalendarService,
      {
        findMatch: jest.fn().mockResolvedValue(null)
      } as unknown as HelpBotStreamKnowledgeSource
    );
    return { answerer, publicAnswer };
  }

  it('uses complete recovery facts instead of public total-TDH data', async () => {
    const { answerer, publicAnswer } = makeAnswerer();
    const result = await answerer.answer({
      question: 'why is my Desktop app total TDH different?',
      baseUrl: 'https://6529.io'
    });
    expect(result.type).toBe('ANSWER');
    if (result.type !== 'ANSWER') throw new Error('Expected a Desktop answer');
    expect(result.record.id).toBe('desktop.tdh-out-of-sync');
    expect(publicAnswer).not.toHaveBeenCalled();
    expect(result.answer).toContain('Reconcile');
    expect(result.answer).toContain('deletes local NFT records');
    expect(result.answer).toContain('never share wallet secrets');
    expect(result.answer).not.toContain('https://6529.io/core');
    expect(result.answer.length).toBeLessThanOrEqual(
      MAX_DESKTOP_ANSWER_CHARACTERS
    );
  });

  it('retains Desktop scope for a specific follow-up without mixing old instructions', async () => {
    const { answerer } = makeAnswerer();
    const result = await answerer.answer({
      question: 'how do I rebuild ownership?',
      previousBotAnswer:
        'In 6529 Desktop, compare TDH and inspect the workers.',
      baseUrl: 'https://6529.io'
    });
    expect(result.type === 'ANSWER' && result.record.id).toBe(
      'desktop.transaction-reset'
    );
  });

  it('uses the previous subject for a pronoun-only follow-up', async () => {
    const { answerer } = makeAnswerer();
    const result = await answerer.answer({
      question: 'How do I fix it?',
      previousBotAnswer:
        'Your 6529 Desktop TDH is out of sync. Compare the same block before repairing history.',
      baseUrl: 'https://6529.io'
    });
    expect(result.type === 'ANSWER' && result.record.id).toBe(
      'desktop.tdh-out-of-sync'
    );
  });

  it('explains full transaction resync through the actual Min Block control', async () => {
    const { answerer } = makeAnswerer();
    const result = await answerer.answer({
      question: 'reset trx worker in Core',
      baseUrl: 'https://6529.io'
    });
    expect(result.type === 'ANSWER' && result.answer).toContain(
      'Reset to Block > Min Block'
    );
    expect(result.type === 'ANSWER' && result.answer).toContain(
      'does not expose a standalone Reset button'
    );
  });

  it.each([
    'what is TDH?',
    'how do I connect a wallet in my browser?',
    'where is the mobile bottom navigation?'
  ])('preserves non-Core retrieval for "%s"', async (question) => {
    const withoutDesktop = JSON.parse(corpus);
    withoutDesktop.records = withoutDesktop.records.filter(
      (record: { id: string }) => !record.id.startsWith('desktop.')
    );
    const baseline = new FrontendHelpBotKnowledgeSource(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(withoutDesktop)
    }));
    expect((await source().findMatch(question))?.record.id).toBe(
      (await baseline.findMatch(question))?.record.id
    );
  });

  it('does not manufacture a recovery match from the platform name alone', async () => {
    const { answerer } = makeAnswerer();
    const result = await answerer.answer({
      question: 'Does 6529 Desktop mine bitcoin?',
      baseUrl: 'https://6529.io'
    });
    expect(result.type).toBe('NO_RELIABLE_SOURCE');
  });

  it.each([
    ['where do I download 6529 Desktop?', 'about.6529-apps'],
    ['how do I connect 6529 desktop?', 'wallet.connection-sharing']
  ])(
    'retains existing app handoff knowledge for "%s"',
    async (question, id) => {
      const { answerer } = makeAnswerer();
      const result = await answerer.answer({
        question,
        baseUrl: 'https://6529.io'
      });
      expect(result.type === 'ANSWER' && result.record.id).toBe(id);
    }
  );

  it('does not carry Core scope into explicit mobile or website questions', () => {
    expect(
      desktopQuestionWithContext(
        'how do I do that on mobile?',
        'Open 6529 Desktop.'
      )
    ).toBeNull();
    expect(
      desktopQuestionWithContext(
        'what is my TDH on 6529.io?',
        'Open 6529 Desktop.'
      )
    ).toBeNull();
  });

  it('falls back to complete corpus steps when the model fails or returns an oversized reply', async () => {
    for (const renderAnswer of [
      jest.fn().mockRejectedValue(new Error('token limit')),
      jest.fn().mockResolvedValue('x'.repeat(7000))
    ]) {
      const { answerer } = makeAnswerer({ renderAnswer });
      const result = await answerer.answer({
        question: 'my tdh in desktop app is out of sync',
        baseUrl: 'https://6529.io'
      });
      expect(result.type === 'ANSWER' && result.answer).toContain(
        'deletes local NFT records'
      );
      expect(result.type === 'ANSWER' && result.answer).toContain(
        'never share wallet secrets'
      );
    }
  });

  it('fails closed when an older published corpus has no Core support', async () => {
    const emptySource = new FrontendHelpBotKnowledgeSource(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          records: [
            {
              id: 'network.tdh',
              title: 'TDH',
              facts: ['TDH is Total Days Held.'],
              keywords: ['tdh'],
              canonical_path: '/network/tdh'
            }
          ]
        })
    }));
    const publicAnswer = jest.fn();
    const answerer = new HelpBotAnswerer(null, emptySource, {
      answer: publicAnswer
    } as unknown as HelpBotPublicDataService);
    const result = await answerer.answer({
      question: 'my desktop app total TDH is different',
      baseUrl: 'https://6529.io'
    });
    expect(result.type).toBe('NO_RELIABLE_SOURCE');
    expect(publicAnswer).not.toHaveBeenCalled();
  });

  it('asks for a narrower question rather than cutting oversized fallback instructions', async () => {
    const oversized = JSON.parse(corpus);
    const record = oversized.records.find(
      (candidate: { id: string }) =>
        candidate.id === 'desktop.transaction-reset'
    );
    record.facts = [
      'Keep the full recovery instructions together. '.repeat(200)
    ];
    const knowledge = new FrontendHelpBotKnowledgeSource(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(oversized)
    }));
    const answerer = new HelpBotAnswerer(null, knowledge);
    const result = await answerer.answer({
      question: 'reset trx worker in Core',
      baseUrl: 'https://6529.io'
    });
    expect(result.type === 'ANSWER' && result.answer).toContain(
      'narrow the question'
    );
    expect(
      result.type === 'ANSWER' && result.answer.length
    ).toBeLessThanOrEqual(MAX_DESKTOP_ANSWER_CHARACTERS);
  });
});
