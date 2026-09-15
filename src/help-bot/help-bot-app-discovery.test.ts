import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HelpBotAnswerer } from './help-bot.answerer';
import { answerAppDiscovery } from './help-bot-app-discovery';
import { FrontendHelpBotKnowledgeSource } from './help-bot.knowledge';

const corpus = readFileSync(
  process.env.HELP_BOT_TEST_CORPUS_PATH ??
    join(__dirname, 'fixtures/desktop-help-index.json'),
  'utf8'
);
const source = (text = corpus) =>
  new FrontendHelpBotKnowledgeSource(async () => ({
    ok: true,
    status: 200,
    text: async () => text
  }));

describe('App discovery', () => {
  it.each([
    'is there an app',
    'is there a 6529 app',
    'app?',
    '6529 app',
    'apps',
    'is there a 6529 application?',
    'do you have an app?',
    'do u have an app',
    'you got an app?',
    'is there any app for this site',
    'where is the app',
    'where can i download the app',
    'app download',
    'app link pls',
    'how do I get the app',
    'download 6529',
    'is there an app for 6529.io',
    'is there an app for my phone'
  ])('answers both platforms concisely for %s', async (question) => {
    const renderer = { renderAnswer: jest.fn() };
    const answerer = new HelpBotAnswerer(renderer, source());
    const result = await answerer.answer({
      question,
      baseUrl: 'https://6529.io'
    });
    expect(result.type).toBe('ANSWER');
    if (result.type !== 'ANSWER') throw new Error('Expected app overview');
    expect(result.record.id).toBe('about.6529-apps');
    expect(result.escalateToTechTeam).toBeFalsy();
    expect(result.answer).toContain('6529 Mobile');
    expect(result.answer).toContain('6529 Desktop');
    expect(result.answer).toContain('iOS and Android');
    expect(result.answer).toContain('Windows, macOS, and Linux');
    expect(result.answer).toMatch(
      /\n\nMore info: \[6529 Apps\]\(https:\/\/6529.io\/about\/6529-apps\)$/
    );
    expect(result.answer.match(/https:/g)).toHaveLength(1);
    expect(result.answer.length).toBeLessThan(400);
    expect(renderer.renderAnswer).not.toHaveBeenCalled();
  });

  it('answers an explicit app question after the previous refusal', async () => {
    const result = await new HelpBotAnswerer(null, source()).answer({
      question: 'is there a 6529 app',
      previousBotAnswer: 'I can only help with 6529 product questions.',
      baseUrl: 'https://6529.io'
    });
    expect(result.type === 'ANSWER' && result.record.id).toBe(
      'about.6529-apps'
    );
  });

  it.each([
    'where do i get it',
    'link?',
    'download?',
    'android?',
    'and desktop?'
  ])('keeps app-download context for %s', async (question) => {
    const answerer = new HelpBotAnswerer(null, source());
    const initial = await answerer.answer({
      question: 'is there an app',
      baseUrl: 'https://6529.io'
    });
    if (initial.type !== 'ANSWER') throw new Error('Expected app overview');
    const result = await answerer.answer({
      question,
      previousBotAnswer: initial.answer,
      baseUrl: 'https://6529.io'
    });
    expect(result.type === 'ANSWER' && result.record.id).toBe(
      'about.6529-apps'
    );
  });

  it.each([
    'How do I back up my mobile Core wallet?',
    'my desktop app is out of sync',
    'is there a Spotify app',
    'is there an app for weather',
    'how do i build an app',
    'where do i get it',
    'android?',
    'what is 6529 Desktop',
    'how do I use 6529 Mobile'
  ])('leaves other intents on their existing path: %s', async (question) => {
    const knowledge = { findMatch: jest.fn() };
    expect(
      await answerAppDiscovery(
        { question, baseUrl: 'https://6529.io' },
        knowledge
      )
    ).toBeNull();
    expect(knowledge.findMatch).not.toHaveBeenCalled();
  });

  it.each(['missing', 'missing-brief', 'missing-links', 'oversized'])(
    'fails closed for an unavailable or incomplete Apps record: %s',
    async (mode) => {
      const older = JSON.parse(corpus);
      const record = older.records.find(
        (r: { id: string }) => r.id === 'about.6529-apps'
      );
      if (mode === 'missing')
        older.records = older.records.filter(
          (r: { id: string }) => r.id !== record.id
        );
      if (mode === 'missing-brief') delete record.brief_answer;
      if (mode === 'missing-links') delete record.answer_links;
      if (mode === 'oversized') record.brief_answer = 'a'.repeat(1300);
      const result = await answerAppDiscovery(
        { question: 'is there an app', baseUrl: 'https://6529.io' },
        source(JSON.stringify(older))
      );
      expect(result).toEqual({
        type: 'NO_RELIABLE_SOURCE',
        escalateToTechTeam: true
      });
    }
  );
});
