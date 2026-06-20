import {
  ensureCanonicalMarkdownLink,
  formatHelpBotMarkdownLink,
  stripHelpBotSelfIntro
} from './help-bot-response-text';

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

describe('formatHelpBotMarkdownLink', () => {
  it('formats a named markdown link', () => {
    expect(
      formatHelpBotMarkdownLink({
        label: 'TDH',
        url: 'https://6529.io/network/tdh'
      })
    ).toBe('[TDH](https://6529.io/network/tdh)');
  });

  it('escapes square brackets in labels', () => {
    expect(
      formatHelpBotMarkdownLink({
        label: 'Meme [SZN1]',
        url: 'https://6529.io/the-memes?szn=1'
      })
    ).toBe('[Meme \\[SZN1\\]](https://6529.io/the-memes?szn=1)');
  });
});

describe('ensureCanonicalMarkdownLink', () => {
  it('replaces a bare canonical URL with a markdown link', () => {
    expect(
      ensureCanonicalMarkdownLink({
        text: 'TDH is Total Days Held.\n\nMore info: https://6529.io/network/tdh',
        canonicalUrl: 'https://6529.io/network/tdh',
        label: 'TDH'
      })
    ).toBe(
      'TDH is Total Days Held.\n\nMore info: [TDH](https://6529.io/network/tdh)'
    );
  });

  it('appends a markdown link when the canonical URL is missing', () => {
    expect(
      ensureCanonicalMarkdownLink({
        text: 'TDH is Total Days Held.',
        canonicalUrl: 'https://6529.io/network/tdh',
        label: 'TDH'
      })
    ).toBe(
      'TDH is Total Days Held.\n\nMore info: [TDH](https://6529.io/network/tdh)'
    );
  });

  it('keeps an existing markdown link to the canonical URL', () => {
    expect(
      ensureCanonicalMarkdownLink({
        text: 'See [the TDH page](https://6529.io/network/tdh).',
        canonicalUrl: 'https://6529.io/network/tdh',
        label: 'TDH'
      })
    ).toBe('See [the TDH page](https://6529.io/network/tdh).');
  });

  it('replaces generic markdown link labels with the canonical label', () => {
    expect(
      ensureCanonicalMarkdownLink({
        text: 'Subscriptions do not create extra eligibility. [More info](https://6529.io/about/subscriptions)',
        canonicalUrl: 'https://6529.io/about/subscriptions',
        label: 'Subscriptions'
      })
    ).toBe(
      'Subscriptions do not create extra eligibility. [Subscriptions](https://6529.io/about/subscriptions)'
    );
  });
});
