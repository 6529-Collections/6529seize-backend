import fc from 'fast-check';
import MarkdownIt from 'markdown-it';
import { DROP_PART_MAX_UTF16_CODE_UNITS } from '@/drops/drop-content-limits';
import { formatDropMarkdownForPush } from '@/pushNotificationsHandler/markdown-push-notification-text';
import { sanitizePushNotificationText } from '@/pushNotificationsHandler/push-notification-text';

jest.mock('@/logging', () => ({
  Logger: { get: () => ({ warn: jest.fn() }) }
}));

describe('formatDropMarkdownForPush', () => {
  afterEach(() => jest.restoreAllMocks());
  it('turns the notification example into a compact readable preview', () => {
    expect(
      formatDropMarkdownForPush(
        '# A Little Markdown Playground\n\nHere is some **bold text**, a touch of *italic text*, and a bit of `inline code`.\n\n- Make something useful\n- Enjoy a coffee break\n\n> Progress starts with a small experiment.'
      )
    ).toBe(
      'A Little Markdown Playground\nHere is some bold text, a touch of italic text, and a bit of ‘inline code’.\n• Make something useful\n• Enjoy a coffee break\n“Progress starts with a small experiment.”'
    );
  });

  it.each([
    ['## Heading ##\n\nParagraph', 'Heading\nParagraph'],
    ['Heading\n=======\n\nParagraph', 'Heading\nParagraph'],
    [
      '***bold italic*** and __bold__ and ~~deleted~~',
      'bold italic and bold and deleted'
    ],
    ['> First\n>\n> Second', '“First\nSecond”'],
    [
      'Before\n\n> Small steps count\n\nAfter',
      'Before\n“Small steps count”\nAfter'
    ],
    ['> Outer\n>\n>> Inner', '“Outer\n‘Inner’”'],
    ['> **Run** `npm test`', '“Run ‘npm test’”'],
    ['> - First\n> - Second', '“• First\n• Second”'],
    ['> First\n\nOutside\n\n> Second', '“First”\nOutside\n“Second”'],
    ['>\n> ![image](https://example.com/a.png)', ''],
    ['> https://example.com/a.png', ''],
    ['> `https://example.com/a.png`', ''],
    ['>\n>>', ''],
    ['- > Quote in a list', '• “Quote in a list”'],
    ['- Intro\n  > Quote\n\nAfter', '• Intro\n“Quote”\nAfter'],
    ['> - Intro\n>   > Nested\n>\n> After', '“• Intro\n‘Nested’\nAfter”'],
    ['| Name | Value |\n| --- | --- |\n| **A** | 2 |', 'Name | Value\nA | 2'],
    ['3. First\n4. Second', '3. First\n4. Second'],
    ['999999999. Last valid start', '999999999. Last valid start'],
    ['9999999999. Not a list', '9999999999. Not a list'],
    [
      '| A | B |\n| --- | --- |\n| **one** | `two` |\n| three | four |',
      'A | B\none | ‘two’\nthree | four'
    ],
    [
      '- First\n  1. Nested\n  2. Again\n- Last',
      '• First\n1. Nested\n2. Again\n• Last'
    ],
    ['- [x] Done\n- [ ] Pending', '• [x] Done\n• [ ] Pending'],
    ['first\r\n\r\nsecond\n\n\nthird', 'first\nsecond\nthird'],
    ['first  \nsecond', 'first\nsecond'],
    ['before\n\n---\n\nafter', 'before\nafter'],
    [
      '**unfinished and [broken](https://example.com',
      '**unfinished and [broken](https://example.com'
    ],
    [
      'Meme #528 costs 2 * 3; use snake_case and C#.',
      'Meme #528 costs 2 * 3; use snake_case and C#.'
    ],
    [
      String.raw`\# literal \*stars\* and \_underscores\_`,
      '# literal *stars* and _underscores_'
    ],
    ['`**literal** snake_case`', '‘**literal** snake_case’'],
    [
      'Run `npm test` then `npm run lint`.',
      'Run ‘npm test’ then ‘npm run lint’.'
    ],
    ['``a `backtick` here``', '‘a `backtick` here’'],
    [
      '```ts\nconst value = "**literal**";\n```\n\nAfter',
      'const value = "**literal**";\nAfter'
    ],
    ['    const value = 2 * 3;\n', 'const value = 2 * 3;'],
    ['Hey @[prxt0] :wave: 👋 **hello**', 'Hey @[prxt0] :wave: 👋 hello'],
    ['Tom &amp; Jerry &#x1F44B;', 'Tom & Jerry 👋'],
    ['[**Read this**](https://example.com/a_(b) "Title")', 'Read this'],
    ['[Read this][docs]\n\n[docs]: https://example.com', 'Read this'],
    [
      '<https://example.com> and https://example.com/a_b',
      'https://example.com and https://example.com/a_b'
    ],
    ['before![alt](https://example.com/a_(b).png)after', 'before after'],
    ['before [report](https://example.com/a_(b).pdf) after', 'before after'],
    ['https://example.com/a.png', ''],
    ['https://example.com/a.png?token=secret', ''],
    ['**Before** https://example.com/a.png *after*', 'Before after'],
    ['> Before https://example.com/a.png', '“Before”'],
    ['```\nhttps://example.com/a.png\n```', ''],
    ['![alt][image]\n\n[image]: https://example.com/a.png', ''],
    ['#\n\n---\n\n![image](https://example.com/a.png)', ''],
    ['', '']
  ])('formats %j as %j', (input, expected) => {
    expect(formatDropMarkdownForPush(input)).toBe(expected);
  });

  it('preserves existing media removal and mention syntax for the send pipeline', () => {
    const preview = formatDropMarkdownForPush(
      '**Hello** @[prxt0]\n\n[Docs](https://example.com) https://example.com/image.png'
    );
    expect(sanitizePushNotificationText(preview)).toBe('Hello @[prxt0]\nDocs');
  });

  it('never includes an image destination in the preview', () => {
    fc.assert(
      fc.property(
        fc.webUrl().filter((url) => !/[()]/.test(url)),
        (url) => {
          expect(formatDropMarkdownForPush(`before ![alt](${url}) after`)).toBe(
            'before after'
          );
        }
      )
    );
  });

  it('rejects oversized content before parsing rather than cutting a media reference', () => {
    const parse = jest.spyOn(MarkdownIt.prototype, 'parse');
    const input =
      '![image](https://example.com/' +
      'x'.repeat(DROP_PART_MAX_UTF16_CODE_UNITS) +
      '.png)';
    expect(formatDropMarkdownForPush(input)).toBe('');
    expect(parse).not.toHaveBeenCalled();
  });

  it('supports content at the existing drop-part limit', () => {
    const input = 'x'.repeat(DROP_PART_MAX_UTF16_CODE_UNITS);
    expect(formatDropMarkdownForPush(input)).toBe(input);
  });

  it('falls back on a parser exception and still formats the next notification', () => {
    jest.spyOn(MarkdownIt.prototype, 'parse').mockImplementationOnce(() => {
      throw new Error('parser failure');
    });
    expect(formatDropMarkdownForPush('**First**')).toBe('');
    expect(formatDropMarkdownForPush('**Next**')).toBe('Next');
  });
});
