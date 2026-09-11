import fc from 'fast-check';
import { formatDropMarkdownForPush } from '@/pushNotificationsHandler/markdown-push-notification-text';
import { sanitizePushNotificationText } from '@/pushNotificationsHandler/push-notification-text';

describe('formatDropMarkdownForPush', () => {
  it('turns the notification example into a compact readable preview', () => {
    expect(
      formatDropMarkdownForPush(
        '# A Little Markdown Playground\n\nHere is some **bold text**, a touch of *italic text*, and a bit of `inline code`.\n\n- Make something useful\n- Enjoy a coffee break\n\n> Progress starts with a small experiment.'
      )
    ).toBe(
      'A Little Markdown Playground\nHere is some bold text, a touch of italic text, and a bit of inline code.\n• Make something useful\n• Enjoy a coffee break\nProgress starts with a small experiment.'
    );
  });

  it.each([
    ['## Heading ##\n\nParagraph', 'Heading\nParagraph'],
    ['Heading\n=======\n\nParagraph', 'Heading\nParagraph'],
    [
      '***bold italic*** and __bold__ and ~~deleted~~',
      'bold italic and bold and deleted'
    ],
    ['> First\n>\n> Second', 'First\nSecond'],
    ['| Name | Value |\n| --- | --- |\n| **A** | 2 |', 'Name | Value\nA | 2'],
    ['3. First\n4. Second', '3. First\n4. Second'],
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
    ['`**literal** snake_case`', '**literal** snake_case'],
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
});
