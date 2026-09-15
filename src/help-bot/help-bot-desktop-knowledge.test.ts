import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HelpBotAnswerer } from './help-bot.answerer';
import { FrontendHelpBotKnowledgeSource } from './help-bot.knowledge';
import { HelpBotPublicDataService } from './help-bot-public-data.service';
import { HelpBotCalendarService } from './help-bot-calendar.service';
import { HelpBotStreamKnowledgeSource } from './help-bot-stream-knowledge';
import {
  desktopQuestionWithContext,
  desktopRecordIdForQuestion,
  isDesktopSupportQuestion,
  MAX_DESKTOP_ANSWER_CHARACTERS,
  MAX_DESKTOP_BRIEF_CHARACTERS
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
  it('keeps mobile handoff routes out of the published help knowledge', () => {
    expect(corpus.toLowerCase()).not.toContain('open-mobile');
  });
  const cases = [
    ['how to get started with 6529 desktop app', 'getting-started'],
    ['how do I get started in Core?', 'getting-started'],
    ['explain Core in depth', 'legacy-core-name'],
    ['how does 6529 desktop work?', 'overview'],
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
    ['Reset to Block in 6529 Desktop', 'transaction-reset'],
    ['Reset to Block Min Block in Core', 'transaction-reset'],
    ['NFT Full Refresh in Core', 'nft-recovery'],
    ['NFT Reset in Core', 'nft-recovery'],
    ['Recalculate TDH Now in Core', 'tdh-calculation'],
    [
      'why is my Desktop app TDH different from the website?',
      'tdh-out-of-sync'
    ],
    ['Why is my Desktop TDH different from the website?', 'tdh-out-of-sync'],
    ['Why does Desktop Merkle differ from the website?', 'tdh-out-of-sync'],
    ['how do I rebuild ownership in Core?', 'transaction-reset'],
    ['how do I do nfts full recovery in Core?', 'nft-recovery'],
    [
      'why is my Desktop app TDH different from TDH on 6529.io?',
      'tdh-out-of-sync'
    ],
    ['my node does not match 6529.io', 'tdh-out-of-sync'],
    ['my node doesnt match 6529.io', 'tdh-out-of-sync'],
    ['what is Core', 'legacy-core-name'],
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

  it.each([
    'installed the desktop app, now what',
    'I installed 6529 Desktop. What do I do next?',
    'installed the desktop app, how do I start?',
    'I opened Core, what next?'
  ])('starts the node after installation: %s', async (question) => {
    const renderer = { renderAnswer: jest.fn() };
    const { answerer, publicAnswer } = makeAnswerer(renderer);
    const result = await answerer.answer({
      question,
      baseUrl: 'https://staging.6529.io'
    });
    expect(result.type).toBe('ANSWER');
    if (result.type !== 'ANSWER')
      throw new Error('Expected setup instructions');
    expect(result.record.id).toBe('desktop.after-installation');
    expect(result.answer).toContain('RPC Providers > Providers List');
    expect(result.answer).toContain('Set Active');
    expect(result.answer).toContain('TDH');
    expect(result.answer).not.toMatch(
      /open-mobile|Connect Device|Have you installed|https?:/
    );
    expect(result.answer.length).toBeLessThan(600);
    expect(renderer.renderAnswer).not.toHaveBeenCalled();
    expect(publicAnswer).not.toHaveBeenCalled();
  });

  it('keeps Desktop context when installation is reported in a reply', async () => {
    const { answerer } = makeAnswerer();
    const result = await answerer.answer({
      question: 'installed it, now what',
      previousBotAnswer:
        'Install 6529 Desktop from the Apps page. Have you installed it already?',
      baseUrl: 'https://6529.io'
    });
    expect(result.type === 'ANSWER' && result.record.id).toBe(
      'desktop.after-installation'
    );
  });

  it.each([
    'I have not installed the desktop app, how do I get started?',
    'I downloaded the desktop app, now what?',
    'installed desktop app, now what about my wallet?',
    'installed desktop app, now what about my wallets?',
    'installed desktop app, now what about an RPC error?',
    'installed desktop app but TDH is out of sync'
  ])(
    'does not replace a specific or incomplete setup question: %s',
    (question) => {
      expect(desktopRecordIdForQuestion(question)).not.toBe(
        'desktop.after-installation'
      );
    }
  );

  it.each([
    'why is my Desktop app total TDH different?',
    'my node doesnt match 6529.io',
    'Why is my Desktop TDH different from the website?',
    'Why does Desktop Merkle differ from the website?'
  ])(
    'starts with a short diagnostic question instead of public TDH or recovery steps: %s',
    async (question) => {
      const { answerer, publicAnswer } = makeAnswerer();
      const result = await answerer.answer({
        question,
        baseUrl: 'https://6529.io'
      });
      expect(result.type).toBe('ANSWER');
      if (result.type !== 'ANSWER')
        throw new Error('Expected a Desktop answer');
      expect(result.record.id).toBe('desktop.tdh-out-of-sync');
      expect(publicAnswer).not.toHaveBeenCalled();
      expect(result.answer).toContain('Last Block');
      expect(result.answer).not.toContain('Reconcile');
      expect(result.answer).not.toContain('Reset');
      expect(result.answer.length).toBeLessThan(500);
      expect(result.answer).not.toContain('https://6529.io/core');
      for (const sourceRef of result.record.sourceRefs) {
        expect(result.answer).not.toContain(sourceRef);
      }
      expect(result.answer.length).toBeLessThanOrEqual(
        MAX_DESKTOP_ANSWER_CHARACTERS
      );
    }
  );

  it('progresses through the reported conversation without dumping or repeating instructions', async () => {
    const renderAnswer = jest.fn().mockRejectedValue(new Error('timeout'));
    const { answerer, publicAnswer } = makeAnswerer({ renderAnswer });
    let previousBotAnswer: string | undefined;
    const turns = [
      ['what is Core', 'legacy-core-name'],
      ['Where do I enable an RPC provider?', 'rpc-providers'],
      ['my tdh calculation is out of sync', 'tdh-out-of-sync'],
      [
        'both caught up, i recalculated, still does not match 6529.io',
        'tdh-after-recalculation'
      ],
      [
        'same Last Block, TDH and Merkle Root differ',
        'tdh-same-block-mismatch'
      ],
      [
        'I reconciled and recalculated, same block, still does not match',
        'tdh-repair-diagnostics'
      ]
    ];
    for (const [question, id] of turns) {
      const result = await answerer.answer({
        question,
        previousBotAnswer,
        baseUrl: 'https://6529.io'
      });
      expect(result.type).toBe('ANSWER');
      if (result.type !== 'ANSWER')
        throw new Error('Expected a conversation answer');
      expect(result.record.id).toBe(`desktop.${id}`);
      expect(result.answer.length).toBeLessThanOrEqual(
        MAX_DESKTOP_BRIEF_CHARACTERS
      );
      expect(result.answer).not.toBe(previousBotAnswer);
      if (id === 'legacy-core-name') {
        expect(result.answer).not.toContain('Set Active');
        expect(result.answer).toMatch(
          /More info: \[6529 Apps\]\(https:\/\/6529\.io\/about\/6529-apps\)$/
        );
      }
      if (id === 'tdh-after-recalculation') {
        expect(result.answer).toContain('already recalculated');
        expect(result.answer).not.toContain('Recalculate TDH Now');
        expect(result.answer).not.toContain('00:15');
        expect(result.answer).not.toContain('Reconcile');
      }
      if (id === 'tdh-same-block-mismatch')
        expect(result.answer).toContain('Reconcile');
      if (id === 'tdh-repair-diagnostics')
        expect(result.answer).toContain('version/OS');
      previousBotAnswer = result.answer;
    }
    expect(publicAnswer).not.toHaveBeenCalled();
    expect(renderAnswer).toHaveBeenCalledTimes(2);
  });

  it.each([
    'same block different tdh and merkle',
    'same Last Block different TDH and Merkle Root',
    'same block, different tdh and merkle',
    'same block but different tdh and merkle',
    'blocks match different tdh and merkle'
  ])(
    'preserves the matching block in a terse mismatch reply: %s',
    async (question) => {
      const { answerer, publicAnswer } = makeAnswerer();
      const initial = await answerer.answer({
        question: 'My node doesnt match 6529.io',
        baseUrl: 'https://6529.io'
      });
      if (initial.type !== 'ANSWER')
        throw new Error('Expected initial diagnostic');
      const result = await answerer.answer({
        question,
        previousBotAnswer: initial.answer,
        baseUrl: 'https://6529.io'
      });
      expect(result.type === 'ANSWER' && result.record.id).toBe(
        'desktop.tdh-check-workers'
      );
      if (result.type !== 'ANSWER')
        throw new Error('Expected worker diagnostic');
      expect(result.answer).not.toContain('Different Last Block values');
      expect(result.answer).toContain('Transactions');
      expect(result.answer).toContain('NFTDelegation');
      expect(result.answer).not.toContain('Reconcile');
      expect(publicAnswer).not.toHaveBeenCalled();
    }
  );

  it.each([
    'no block is same',
    'no the Last Block is the same',
    'no, block is same',
    'no! block is same'
  ])(
    'accepts a correction to the previous block mismatch: %s',
    async (question) => {
      const { answerer } = makeAnswerer();
      const previous = await answerer.answer({
        question: 'My node doesnt match 6529.io, different blocks',
        baseUrl: 'https://6529.io'
      });
      if (previous.type !== 'ANSWER')
        throw new Error('Expected block diagnostic');
      const result = await answerer.answer({
        question,
        previousBotAnswer: previous.answer,
        baseUrl: 'https://6529.io'
      });
      expect(result.type === 'ANSWER' && result.record.id).toBe(
        'desktop.tdh-check-workers'
      );
    }
  );

  it.each([
    'no block is the same',
    'no blocks are the same',
    'the block is not the same',
    'no block is same?',
    'no block is same but I am not sure the blocks match'
  ])(
    'does not infer matching blocks from an ambiguous or negated report: %s',
    (question) => {
      expect(
        desktopRecordIdForQuestion(
          question,
          'In 6529 Desktop, your node does not match 6529.io. Are the Last Block values identical?'
        )
      ).not.toBe('desktop.tdh-check-workers');
    }
  );

  it.each([
    'the Last Block values are different',
    'my block is different',
    'different blocks',
    'blocks do not match',
    'last block different',
    'TDH differs, block different',
    'same TDH but different blocks'
  ])('preserves actual block mismatches: %s', (question) => {
    expect(
      desktopRecordIdForQuestion(
        question,
        'In 6529 Desktop, your node does not match 6529.io. Are the Last Block values identical?'
      )
    ).toBe('desktop.tdh-block-mismatch');
  });

  it('uses checkpoint and worker replies to advance troubleshooting', async () => {
    const { answerer } = makeAnswerer();
    let previousBotAnswer =
      'In 6529 Desktop, your node does not match 6529.io. Are the Last Block values identical?';
    for (const [question, id] of [
      ['the Last Block values are different', 'tdh-block-mismatch'],
      ['now same Last Block but TDH still does not match', 'tdh-check-workers'],
      ['both caught up', 'tdh-recalculate'],
      [
        'I recalculated, still does not match 6529.io',
        'tdh-after-recalculation'
      ]
    ]) {
      const result = await answerer.answer({
        question,
        previousBotAnswer,
        baseUrl: 'https://6529.io'
      });
      expect(result.type === 'ANSWER' && result.record.id).toBe(
        `desktop.${id}`
      );
      if (result.type !== 'ANSWER') throw new Error('Expected a next step');
      expect(result.answer).not.toBe(previousBotAnswer);
      previousBotAnswer = result.answer;
    }
  });

  it.each([
    'Where do I enable an RPC provider?',
    'How do I reconcile transactions?'
  ])(
    'asks for the application when terminology alone is ambiguous: %s',
    async (question) => {
      const { answerer } = makeAnswerer();
      const result = await answerer.answer({
        question,
        baseUrl: 'https://6529.io'
      });
      expect(result.type === 'ANSWER' && result.record.id).toBe(
        'desktop.clarify-context'
      );
      expect(result.type === 'ANSWER' && result.answer).toContain(
        'or another app?'
      );
    }
  );

  it.each([
    'I have not recalculated, my node still does not match 6529.io',
    "I haven't yet recalculated, my node still does not match 6529.io",
    'I have not actually even once recalculated, my node still does not match 6529.io',
    'I have never in fact recalculated, my node still does not match 6529.io',
    'Maybe it recalculated, my node still does not match 6529.io',
    'If I recalculated, would my node still not match 6529.io?'
  ])(
    'does not infer completed actions from a negated report: %s',
    async (question) => {
      const { answerer } = makeAnswerer();
      const result = await answerer.answer({
        question,
        previousBotAnswer:
          'In 6529 Desktop, have you recalculated TDH? Your node is out of sync.',
        baseUrl: 'https://6529.io'
      });
      expect(result.type === 'ANSWER' && result.record.id).toBe(
        'desktop.tdh-out-of-sync'
      );
      expect(result.type === 'ANSWER' && result.answer).not.toContain(
        'already recalculated'
      );
    }
  );

  it.each([
    'I have not actually even once recalculated, same block, TDH still differs',
    'I did not really ever recalculate, same block, TDH still differs',
    'I recalculated, I am not sure the blocks are the same, TDH still differs',
    'I recalculated, are the blocks the same? TDH still differs'
  ])('does not advance to repair on uncertain progress: %s', (question) => {
    const id = desktopRecordIdForQuestion(
      question,
      'In 6529 Desktop, you have already recalculated. Your node does not match 6529.io.'
    );
    expect(id).not.toBe('desktop.tdh-same-block-mismatch');
    expect(id).not.toBe('desktop.tdh-repair-diagnostics');
  });

  it.each([
    'I have not actually even once reconciled, TDH still differs',
    'If I reconciled, would TDH still differ?',
    'Have I reconciled? TDH still differs'
  ])('does not infer reconciliation from uncertainty: %s', (question) => {
    expect(desktopRecordIdForQuestion(question)).toBe(
      'desktop.tdh-out-of-sync'
    );
  });

  it.each([
    'Have both workers recalculated?',
    'Have both workers recalculated',
    'Has my node recalculated?',
    'Are both blocks the same?',
    'Are both blocks the same',
    'Have both workers reconciled?',
    'Both workers recalculated?',
    'Both blocks are the same?',
    'Which workers recalculated',
    'Who recalculated',
    'When were both workers recalculated',
    'Why were both workers reconciled',
    'How were both workers recalculated',
    'What was recalculated',
    'Which blocks are the same'
  ])(
    'does not treat a progress question as confirmation: %s',
    async (question) => {
      const { answerer } = makeAnswerer();
      const result = await answerer.answer({
        question,
        previousBotAnswer:
          'In 6529 Desktop, your node does not match 6529.io. Compare the Last Block values.',
        baseUrl: 'https://6529.io'
      });
      expect(result.type === 'ANSWER' && result.record.id).toBe(
        'desktop.tdh-out-of-sync'
      );
    }
  );

  it.each([
    ['Both workers recalculated', 'tdh-after-recalculation'],
    ['Both blocks are the same', 'tdh-check-workers'],
    ['Both workers reconciled', 'tdh-after-reconciliation'],
    ['Have both workers recalculated? I recalculated', 'tdh-out-of-sync'],
    ['Are both blocks the same? I recalculated', 'tdh-after-recalculation'],
    ['I recalculated. Are both blocks the same?', 'tdh-after-recalculation']
  ])('preserves only confirmed progress in %s', (question, expected) => {
    expect(
      desktopRecordIdForQuestion(
        question,
        'In 6529 Desktop, your node does not match 6529.io.'
      )
    ).toBe(`desktop.${expected}`);
  });

  it('accepts an affirmative block comparison after recalculation', () => {
    expect(
      desktopRecordIdForQuestion(
        'I recalculated, the Last Block values are the same, TDH differs'
      )
    ).toBe('desktop.tdh-same-block-mismatch');
  });

  it('lets current uncertainty override an earlier block confirmation', () => {
    expect(
      desktopRecordIdForQuestion(
        'I am not sure the blocks match, both caught up',
        'In 6529 Desktop, your node still does not match 6529.io at the same Last Block.'
      )
    ).toBe('desktop.tdh-out-of-sync');
  });

  it.each([
    ['I reconciled but have not recalculated', 'tdh-after-reconciliation'],
    [
      'I ran reconciliation; not sure I recalculated',
      'tdh-after-reconciliation'
    ],
    ['I reconciled and recalculated', 'tdh-repair-diagnostics']
  ])(
    'uses only confirmed completion after reconciliation: %s',
    (question, expected) => {
      expect(
        desktopRecordIdForQuestion(
          question,
          'In 6529 Desktop, your node does not match 6529.io.'
        )
      ).toBe(`desktop.${expected}`);
    }
  );

  it('prioritizes a symptom in a compound definition question', () => {
    expect(
      desktopRecordIdForQuestion('what is Core, my node is out of sync?')
    ).toBe('desktop.tdh-out-of-sync');
  });

  it('does not turn a block definition into another mismatch step', () => {
    expect(
      desktopRecordIdForQuestion(
        'What is an Ethereum block?',
        'In 6529 Desktop, your node does not match 6529.io. Compare Last Block.'
      )
    ).toBeUndefined();
  });

  it('does not treat a wallet mismatch as a TDH mismatch', async () => {
    const { answerer } = makeAnswerer();
    const result = await answerer.answer({
      question: 'My Core wallet password does not match',
      baseUrl: 'https://6529.io'
    });
    expect(result.type === 'ANSWER' && result.record.id).toBe(
      'desktop.wallet-backup'
    );
  });

  it('keeps full instructions and warnings when detail is explicitly requested', async () => {
    const { answerer } = makeAnswerer();
    const result = await answerer.answer({
      question: 'Explain in detail how to reset trx worker in Core',
      baseUrl: 'https://6529.io'
    });
    expect(result.type === 'ANSWER' && result.answer).toContain(
      'Reset to Block'
    );
    expect(result.type === 'ANSWER' && result.answer).toContain('are deleted');
    expect(result.type === 'ANSWER' && result.answer.length).toBeGreaterThan(
      1200
    );
  });

  it('moves approved links to the footer and discards invented links', async () => {
    const { answerer } = makeAnswerer({
      renderAnswer: jest
        .fn()
        .mockResolvedValue(
          'Get the [app](https://6529.io/about/6529-apps). Read [this](https://example.com/wrong) or [that](/core).'
        )
    });
    const result = await answerer.answer({
      question: 'what is Core',
      baseUrl: 'https://staging.6529.io'
    });
    expect(result.type === 'ANSWER' && result.answer).toBe(
      'Get the app. Read this or that.\n\nMore info: [6529 Apps](https://6529.io/about/6529-apps)'
    );
  });

  it.each([
    ['Core (https://example.com/wrong) runs locally.', 'Core runs locally.'],
    ['Core <https://example.com/wrong> runs locally.', 'Core runs locally.'],
    ['Core https://example.com/wrong runs locally.', 'Core runs locally.'],
    ['Open https://example.com/docs.', 'Open.'],
    ['See https://example.com/docs, then continue.', 'See, then continue.'],
    ['See https://example.com/docs; then continue.', 'See; then continue.'],
    ['Open https://example.com/docs!', 'Open!'],
    ['Open https://example.com/docs?', 'Open?'],
    ['Open https://example.com/docs?!', 'Open?!'],
    ['Open https://example.com/a.b?q=what?next=yes.', 'Open.'],
    ['Open https://example.com/a]b.', 'Open.'],
    ['Open https://example.com/a}b.', 'Open.'],
    ['Open (https://example.com/docs).', 'Open.'],
    ['Open <https://example.com/docs>.', 'Open.'],
    [
      'Read [note] then [that](https://example.com/wrong).',
      'Read [note] then that.'
    ],
    ['Read [a] b](https://example.com/wrong).', 'Read [a] b].'],
    [
      'Core (on your machine) runs locally.',
      'Core (on your machine) runs locally.'
    ]
  ])(
    'cleans URL wrappers without discarding surrounding prose: %s',
    async (input, expected) => {
      const { answerer } = makeAnswerer({
        renderAnswer: jest.fn().mockResolvedValue(input)
      });
      const result = await answerer.answer({
        question: 'what is Core',
        baseUrl: 'https://6529.io'
      });
      expect(result.type === 'ANSWER' && result.answer).toBe(
        `${expected}\n\nMore info: [6529 Apps](https://6529.io/about/6529-apps)`
      );
    }
  );

  it('preserves mid-body More info text while replacing only a trailing footer', async () => {
    const { answerer } = makeAnswerer({
      renderAnswer: jest
        .fn()
        .mockResolvedValue(
          'Core runs locally.\nMore info: workers index Ethereum.\nKeep the app open.\n\nMore info: [bad](https://example.com)'
        )
    });
    const result = await answerer.answer({
      question: 'what is Core',
      baseUrl: 'https://6529.io'
    });
    expect(result.type === 'ANSWER' && result.answer).toBe(
      'Core runs locally.\nMore info: workers index Ethereum.\nKeep the app open.\n\nMore info: [6529 Apps](https://6529.io/about/6529-apps)'
    );
  });

  it('replaces a lone generated footer with the concise corpus fallback', async () => {
    const { answerer } = makeAnswerer({
      renderAnswer: jest
        .fn()
        .mockResolvedValue('More info: [bad](https://example.com)')
    });
    const result = await answerer.answer({
      question: 'what is Core',
      baseUrl: 'https://6529.io'
    });
    expect(result.type === 'ANSWER' && result.answer).toBe(
      '**6529 Core** was the former name of **6529 Desktop**. The official current name is 6529 Desktop; the mobile application is called 6529 Mobile. Would you like help with 6529 Desktop or 6529 Mobile?\n\nMore info: [6529 Apps](https://6529.io/about/6529-apps)'
    );
  });

  it('preserves an authored one-line More info answer in corpus fallback', async () => {
    const match = await source().findMatch('what is Core');
    if (!match) throw new Error('Expected overview record');
    const { desktopFallbackAnswer, normalizeDesktopAnswer } =
      await import('./help-bot-desktop-answer');
    const briefAnswer =
      'More info: 6529 Desktop workers index Ethereum locally.';
    const record = { ...match.record, briefAnswer };
    const expected = `${briefAnswer}\n\nMore info: [6529 Apps](https://6529.io/about/6529-apps)`;
    expect(desktopFallbackAnswer(record, 'what is Core')).toBe(expected);
    expect(
      normalizeDesktopAnswer(
        'More info: [bad](https://example.com)',
        record,
        'what is Core'
      )
    ).toBe(expected);
  });

  it('bounds the entire deterministic reply including a long link footer', async () => {
    const match = await source().findMatch('what is Core');
    if (!match) throw new Error('Expected overview record');
    const { desktopFallbackAnswer } = await import('./help-bot-desktop-answer');
    const answer = desktopFallbackAnswer(
      {
        ...match.record,
        briefAnswer: 'a'.repeat(900),
        answerLinks: [
          { label: 'b'.repeat(400), url: 'https://6529.io/about/6529-apps' }
        ]
      },
      'what is Core'
    );
    expect(answer.length).toBeLessThanOrEqual(MAX_DESKTOP_BRIEF_CHARACTERS);
    expect(answer).toContain('focus on');
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
      'no standalone Reset button'
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

  it('ranks only eligible Desktop records even when a generic record strongly matches', async () => {
    const question = 'why is my Desktop app total TDH different?';
    const competing = JSON.parse(corpus);
    competing.records.push({
      id: 'generic.competing-tdh',
      title: question,
      aliases: question
        .split(' ')
        .map((_, index, words) => words.slice(index).join(' ')),
      keywords: question.split(' '),
      facts: ['Public profile TDH guidance.'],
      canonical_path: '/network/tdh',
      tags: ['tdh']
    });
    const knowledge = new FrontendHelpBotKnowledgeSource(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(competing)
    }));
    // Prove the competitor is eligible and highly relevant in the generic scope.
    expect(
      (await knowledge.findMatch(question, { desktopScope: false }))?.record.id
    ).toBe('generic.competing-tdh');
    const matches = await knowledge.findMatches(question, 20, {
      desktopScope: true
    });
    expect(matches[0]?.record.id).toBe('desktop.tdh-out-of-sync');
    expect(matches.map((match) => match.record.id)).not.toContain(
      'generic.competing-tdh'
    );
    const answerer = new HelpBotAnswerer(null, knowledge);
    const result = await answerer.answer({
      question,
      baseUrl: 'https://6529.io'
    });
    expect(result.type === 'ANSWER' && result.record.id).toBe(
      'desktop.tdh-out-of-sync'
    );
  });

  it('allows ordinary app handoff retrieval but rejects it as a forced Desktop stage', async () => {
    const knowledge = source();
    const question = 'how do I connect 6529 desktop?';
    expect((await knowledge.findMatch(question))?.record.id).toBe(
      'wallet.connection-sharing'
    );
    expect(
      await knowledge.findMatch(question, {
        desktopScope: true,
        desktopRecordId: 'wallet.connection-sharing'
      })
    ).toBeNull();
  });

  it.each([
    ['My node does not match 6529.io', 'desktop.tdh-out-of-sync'],
    ['what is Core', 'desktop.legacy-core-name'],
    ['what is 6529 Desktop', 'desktop.overview'],
    ['Where do I enable an RPC provider?', 'desktop.clarify-context']
  ])(
    'rejects a forced record whose Desktop eligibility was lost: %s',
    async (question, id) => {
      const changed = JSON.parse(corpus);
      const record = changed.records.find(
        (item: { id: string }) => item.id === id
      );
      if (!record) throw new Error('Expected Desktop corpus record');
      record.tags = ['desktop'];
      const knowledge = new FrontendHelpBotKnowledgeSource(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(changed)
      }));
      const publicAnswer = jest.fn();
      const answerer = new HelpBotAnswerer(null, knowledge, {
        answer: publicAnswer
      } as unknown as HelpBotPublicDataService);
      const result = await answerer.answer({
        question,
        baseUrl: 'https://6529.io'
      });
      expect(result.type).toBe('NO_RELIABLE_SOURCE');
      expect(publicAnswer).not.toHaveBeenCalled();
    }
  );

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

  it('answers the Core-on-mobile question with the current product names', async () => {
    const { answerer } = makeAnswerer();
    const result = await answerer.answer({
      question: 'How do I use Core wallets on mobile?',
      baseUrl: 'https://6529.io'
    });
    expect(result.type).toBe('ANSWER');
    if (result.type !== 'ANSWER') throw new Error('Expected a wallet answer');
    expect(result.record.id).toBe('wallets.mobile-overview');
    expect(result.answer).toContain('6529 Mobile');
    expect(result.answer).not.toContain('6529 Desktop > Wallets');
  });

  describe.each([
    ['mobile wallet', 'wallets.mobile-'],
    ['mobile Core wallet', 'wallets.mobile-'],
    ['Core wallet on mobile', 'wallets.mobile-'],
    ['mobile app Core wallet', 'wallets.mobile-'],
    ['Core wallet on Android', 'wallets.mobile-'],
    ['Core wallet on iOS', 'wallets.mobile-'],
    ['desktop wallet', 'desktop.'],
    ['desktop Core wallet', 'desktop.']
  ])('wallet instructions using %s', (wallet, prefix) => {
    it.each([
      ['How do I create a WALLET?', 'create-import', 'wallets'],
      ['How do I import a WALLET?', 'create-import', 'wallets'],
      ['How do I connect my WALLET?', 'connect', 'wallets'],
      ['How do I back up my WALLET?', 'backup-recovery', 'wallet-backup'],
      ['I forgot my WALLET password', 'backup-recovery', 'wallet-backup'],
      ['How do I delete my WALLET?', 'delete-troubleshooting', 'wallets']
    ])('%s', async (template, mobileId, desktopId) => {
      const question = template.replace('WALLET', wallet);
      const expected = prefix + (prefix === 'desktop.' ? desktopId : mobileId);
      const { answerer } = makeAnswerer();
      const result = await answerer.answer({
        question,
        baseUrl: 'https://6529.io'
      });
      expect(result.type === 'ANSWER' && result.record.id).toBe(expected);
      if (result.type !== 'ANSWER')
        throw new Error('Expected wallet instructions');
      expect(result.answer).not.toContain('6529 Desktop (Core)');
      if (prefix !== 'desktop.') {
        expect(result.answer).not.toContain('6529 Desktop > Wallets');
      }
    });
  });

  it.each([
    'Can I use my Desktop Core wallet on mobile?',
    'Does my 6529 Desktop wallet automatically appear in 6529 Mobile?'
  ])('keeps cross-platform wallet questions distinct: %s', async (question) => {
    const { answerer } = makeAnswerer();
    const result = await answerer.answer({
      question,
      baseUrl: 'https://6529.io'
    });
    expect(result.type === 'ANSWER' && result.record.id).toBe(
      'wallets.core-mobile-clarification'
    );
    expect(result.type === 'ANSWER' && result.answer).toContain(
      'does not automatically appear'
    );
  });

  it.each([
    ['mobile Core wallets', 'wallets.mobile-overview'],
    ['desktop Core wallets', 'desktop.wallets'],
    [
      'How do I back up my mobile Core wallets?',
      'wallets.mobile-backup-recovery'
    ],
    ['How do I back up my desktop Core wallets?', 'desktop.wallet-backup'],
    [
      'How do I create another mobile Core wallet?',
      'wallets.mobile-create-import'
    ],
    [
      'How do I delete a Core wallet on mobile?',
      'wallets.mobile-delete-troubleshooting'
    ]
  ])('keeps wallet aliases on the requested task: %s', async (question, id) => {
    const { answerer } = makeAnswerer();
    const result = await answerer.answer({
      question,
      baseUrl: 'https://6529.io'
    });
    expect(result.type === 'ANSWER' && result.record.id).toBe(id);
  });

  it('uses only the current name when defining 6529 Desktop', async () => {
    const { answerer } = makeAnswerer();
    const result = await answerer.answer({
      question: 'what is 6529 Desktop',
      baseUrl: 'https://6529.io'
    });
    expect(result.type).toBe('ANSWER');
    if (result.type !== 'ANSWER') throw new Error('Expected a Desktop answer');
    expect(result.record.id).toBe('desktop.overview');
    expect(result.answer).toContain('6529 Desktop');
    expect(result.answer).not.toMatch(/\bCore\b/);
  });

  it.each([
    ['what are App Wallets in 6529 Mobile?', 'mobile-overview'],
    ['how do I create a wallet in 6529 Mobile?', 'mobile-create-import'],
    ['how do I import a private key in 6529 Mobile?', 'mobile-create-import'],
    ['how do I connect an App Wallet?', 'mobile-connect'],
    ['how do I back up my mobile wallet?', 'mobile-backup-recovery'],
    ['I forgot my mobile wallet password', 'mobile-backup-recovery'],
    ['why are App Wallets missing?', 'mobile-delete-troubleshooting'],
    ['how do I delete an App Wallet?', 'mobile-delete-troubleshooting']
  ])(
    'answers Mobile wallet question "%s" from wallets.%s',
    async (question, id) => {
      const { answerer } = makeAnswerer();
      const result = await answerer.answer({
        question,
        baseUrl: 'https://6529.io'
      });
      expect(result.type === 'ANSWER' && result.record.id).toBe(
        `wallets.${id}`
      );
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
    expect(
      desktopQuestionWithContext(
        'how do I do that on web?',
        'Open 6529 Desktop.'
      )
    ).toBeNull();
  });

  it.each([
    'How do I use Core wallets on mobile?',
    'How do I use Core wallets on Android?',
    'How do I use Core wallets on iOS?',
    'How do I use Core wallets in my browser?',
    'How do I use Core wallets on the website?',
    'How do I use Core wallets on 6529.io?',
    'How do I use Core wallets for mobile?',
    'How do I use Core wallets on web?',
    'mobile Core wallets',
    'browser Core RPC setup',
    'website Core wallets',
    'Android Core wallets',
    'iOS Core wallets',
    'web Core RPC setup',
    '6529.io Core wallets',
    'Is mobile Core TDH different from Desktop TDH?'
  ])(
    'excludes explicit platform targets even when Core is mentioned: %s',
    async (question) => {
      expect(isDesktopSupportQuestion(question)).toBe(false);
      expect(
        desktopQuestionWithContext(question, 'Open 6529 Desktop.')
      ).toBeNull();
      expect((await source().findMatch(question))?.record.id ?? '').not.toMatch(
        /^desktop\./
      );
      const { answerer } = makeAnswerer();
      const result = await answerer.answer({
        question,
        previousBotAnswer: 'Open 6529 Desktop > Wallets.',
        baseUrl: 'https://6529.io'
      });
      if (result.type === 'ANSWER') {
        expect(result.record.id).not.toMatch(/^desktop\./);
      }
    }
  );

  it('keeps the validated follow-up scope when the previous answer mentions other platforms', async () => {
    const { answerer } = makeAnswerer();
    const result = await answerer.answer({
      question: 'How do I fix it?',
      previousBotAnswer:
        'Your 6529 Desktop TDH is out of sync. Desktop tools are unavailable in 6529 Mobile and in a browser.',
      baseUrl: 'https://6529.io'
    });
    expect(result.type === 'ANSWER' && result.record.id).toBe(
      'desktop.tdh-out-of-sync'
    );
  });

  it('propagates a cold corpus failure to the processor instead of escalating as missing knowledge', async () => {
    const fetcher = jest
      .fn()
      .mockRejectedValue(new Error('temporary corpus outage'));
    const knowledge = new FrontendHelpBotKnowledgeSource(fetcher);
    const publicAnswer = jest.fn();
    const answerer = new HelpBotAnswerer(null, knowledge, {
      answer: publicAnswer
    } as unknown as HelpBotPublicDataService);
    await expect(
      answerer.answer({
        question: 'why is my Desktop app total TDH different?',
        baseUrl: 'https://6529.io'
      })
    ).rejects.toThrow('Frontend help index is currently unavailable');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(publicAnswer).not.toHaveBeenCalled();
  });

  it('falls back to a short answer when the model fails or returns an oversized reply', async () => {
    for (const renderAnswer of [
      jest.fn().mockRejectedValue(new Error('token limit')),
      jest.fn().mockResolvedValue('x'.repeat(7000))
    ]) {
      const { answerer } = makeAnswerer({ renderAnswer });
      const result = await answerer.answer({
        question: 'Where do I enable an RPC provider in Core?',
        baseUrl: 'https://6529.io'
      });
      expect(renderAnswer).toHaveBeenCalledTimes(1);
      expect(result.type === 'ANSWER' && result.answer).toContain('Set Active');
      expect(result.type === 'ANSWER' && result.answer.length).toBeLessThan(
        500
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

  it.each([
    ['My node does not match 6529.io', 'desktop.tdh-out-of-sync'],
    [
      'My node does not match 6529.io, different blocks',
      'desktop.tdh-block-mismatch'
    ],
    ['My node does not match 6529.io, same block', 'desktop.tdh-check-workers'],
    [
      'My node does not match 6529.io, same block, both caught up',
      'desktop.tdh-recalculate'
    ],
    [
      'My node does not match 6529.io, I recalculated',
      'desktop.tdh-after-recalculation'
    ],
    [
      'My node does not match 6529.io, I recalculated, same block',
      'desktop.tdh-same-block-mismatch'
    ],
    [
      'My node does not match 6529.io, I reconciled',
      'desktop.tdh-after-reconciliation'
    ],
    [
      'My node does not match 6529.io, I reconciled and recalculated',
      'desktop.tdh-repair-diagnostics'
    ]
  ])(
    'fails closed when the selected stage is missing: %s',
    async (question, stage) => {
      expect((await source().findMatch(question))?.record.id).toBe(stage);
      const older = JSON.parse(corpus);
      older.records = older.records.filter(
        (record: { id: string }) => record.id !== stage
      );
      const knowledge = new FrontendHelpBotKnowledgeSource(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(older)
      }));
      const publicAnswer = jest.fn();
      const answerer = new HelpBotAnswerer(null, knowledge, {
        answer: publicAnswer
      } as unknown as HelpBotPublicDataService);
      const result = await answerer.answer({
        question,
        baseUrl: 'https://6529.io'
      });
      expect(result.type).toBe('NO_RELIABLE_SOURCE');
      expect(publicAnswer).not.toHaveBeenCalled();
    }
  );

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
      question: 'give me a full guide to reset trx worker in Core',
      baseUrl: 'https://6529.io'
    });
    expect(result.type === 'ANSWER' && result.answer).toContain('focus on');
    expect(
      result.type === 'ANSWER' && result.answer.length
    ).toBeLessThanOrEqual(MAX_DESKTOP_ANSWER_CHARACTERS);
  });
});
