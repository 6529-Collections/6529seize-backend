import { stripHelpBotSelfIntro } from './help-bot-response-text';

describe('stripHelpBotSelfIntro', () => {
  it.each([
    ['@6529help here! TDH stands for Total Days Held.'],
    ['@6529help: TDH stands for Total Days Held.'],
    ['6529help: TDH stands for Total Days Held.'],
    ['6529help here - TDH stands for Total Days Held.'],
    ['Hey, @6529help here! TDH stands for Total Days Held.']
  ])('removes help bot self-intro prefix from "%s"', (text) => {
    expect(stripHelpBotSelfIntro(text)).toBe('TDH stands for Total Days Held.');
  });

  it('leaves direct answers unchanged', () => {
    expect(stripHelpBotSelfIntro('TDH stands for Total Days Held.')).toBe(
      'TDH stands for Total Days Held.'
    );
  });
});
