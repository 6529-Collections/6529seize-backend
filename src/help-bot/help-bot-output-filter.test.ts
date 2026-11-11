import fc from 'fast-check';
import {
  defaultHelpBotAllowedOrigins,
  filterHelpBotReplyText
} from './help-bot-output-filter';

const ORIGINS = ['https://6529.io', 'https://staging.6529.io'];
const BARE_URL = /(?:https?:\/\/|www\.)[^\s<>()[\]]+/g;

function filter(
  text: string,
  options: Parameters<typeof filterHelpBotReplyText>[1] = {}
): string {
  return filterHelpBotReplyText(text, { allowedOrigins: ORIGINS, ...options });
}

describe('filterHelpBotReplyText', () => {
  it('keeps Markdown and bare links on allowed 6529.io origins', () => {
    const text =
      'See [TDH](https://6529.io/network/tdh) or https://staging.6529.io/waves.';
    expect(filter(text)).toBe(text);
  });

  it('keeps the label of an off-site Markdown link as plain text', () => {
    expect(filter('Claim it [here](https://example.com/claim) today.')).toBe(
      'Claim it here today.'
    );
  });

  it('removes off-site bare URLs and autolinks', () => {
    expect(
      filter('Go to https://example.com/x, or <https://evil.test/y> now.')
    ).toBe('Go to, or now.');
  });

  it('does not treat look-alike hosts or other schemes as 6529.io', () => {
    expect(
      filter(
        '[a](https://6529.io.example.com/x) [b](http://6529.io/x) [c](https://user@6529.io/x) [d](javascript:alert(1)) [e](/network)'
      )
    ).toBe('a b c d) e');
  });

  it('turns image embeds into their alt text', () => {
    expect(filter('![logo](https://6529.io/logo.png)')).toBe('logo');
  });

  it('does not leave a URL label clickable once de-linked', () => {
    expect(filter('[https://example.com](https://example.com)')).toBe('');
  });

  it('neutralises group mention tokens unless allowed', () => {
    expect(filter('Hey @all, @Contributors, @admins and @devs6529!')).toBe(
      'Hey all, Contributors, admins and devs6529!'
    );
    expect(
      filter('Flagging @devs6529 and @all', {
        allowedGroupMentions: ['devs6529']
      })
    ).toBe('Flagging @devs6529 and all');
  });

  it('keeps email addresses intact', () => {
    expect(filter('Mail team@all.example today')).toBe(
      'Mail team@all.example today'
    );
  });

  it('neutralises group mention tokens inside kept links too', () => {
    expect(filter('Open https://6529.io/network!@all now')).toBe(
      'Open https://6529.io/network!all now'
    );
    expect(filter('[x](https://6529.io/@admins)')).toBe(
      '[x](https://6529.io/admins)'
    );
  });

  it('keeps user mentions found in the source knowledge only', () => {
    expect(
      filter('Ask @[punk6529] or @[someone] or @stranger', {
        sourceText: 'Founder: @[punk6529]'
      })
    ).toBe('Ask @[punk6529] or someone or stranger');
  });

  it('leaves user mentions unchanged when no source rule is requested', () => {
    expect(filter('Ask @[someone]', { sourceText: null })).toBe(
      'Ask @[someone]'
    );
  });

  it('always keeps the help bot handle', () => {
    expect(filter('Ask @help6529 again', { sourceText: '' })).toBe(
      'Ask @help6529 again'
    );
  });

  it('is idempotent and never leaves an off-site URL behind', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.constantFrom(
              'https://example.com/a',
              '[x](https://example.com)',
              '<https://evil.test>',
              'https://6529.io/network',
              '@all',
              ' ',
              '\n',
              '.'
            ),
            fc.string({ maxLength: 8 })
          ),
          { maxLength: 12 }
        ),
        (parts) => {
          const once = filter(parts.join(''));
          expect(filter(once)).toBe(once);
          for (const url of once.match(BARE_URL) ?? []) {
            const origin = new URL(url.replace(/[.,;:!?'"]+$/, '')).origin;
            expect(ORIGINS).toContain(origin);
          }
          expect(once).not.toMatch(/(^|[^a-z0-9_@])@all(?![a-z0-9_@])/i);
        }
      )
    );
  });
});

describe('defaultHelpBotAllowedOrigins', () => {
  it('allows production and the configured https base URL origin', () => {
    expect(defaultHelpBotAllowedOrigins('https://staging.6529.io')).toEqual([
      'https://6529.io',
      'https://staging.6529.io'
    ]);
    expect(defaultHelpBotAllowedOrigins('http://localhost:3000')).toEqual([
      'https://6529.io'
    ]);
  });
});
