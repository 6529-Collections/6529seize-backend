import fc from 'fast-check';
import {
  NewsletterOutputError,
  parseNewsletterOutput,
  stripCodeFence
} from './newsletter-output.schema';

const valid = {
  sections: [
    {
      heading: 'A story',
      paragraphs: [{ text: 'Something happened.', citations: ['drop:1'] }]
    }
  ],
  winners_covered: [],
  mints_covered: []
};

describe('newsletter output contract', () => {
  it('parses bare JSON and JSON inside a single code fence', () => {
    const json = JSON.stringify(valid);
    expect(parseNewsletterOutput(json)).toEqual(valid);
    expect(parseNewsletterOutput('```json\n' + json + '\n```')).toEqual(valid);
    expect(parseNewsletterOutput('  ```\n' + json + '```  ')).toEqual(valid);
    expect(stripCodeFence('plain')).toBe('plain');
  });

  it('rejects malformed, prose, and unsupported output with reasons', () => {
    const cases: [string, string][] = [
      ['## A Markdown newsletter', 'malformed output'],
      ['{"sections":[]}', 'unsupported output'],
      [JSON.stringify({ ...valid, extra: 1 }), 'unsupported output'],
      [
        JSON.stringify({
          ...valid,
          sections: [
            { heading: 'x', paragraphs: [{ text: '', citations: [] }] }
          ]
        }),
        'unsupported output'
      ],
      [
        JSON.stringify({
          ...valid,
          sections: [
            {
              heading: 'x',
              paragraphs: [{ text: 'y', citations: ['https://6529.io/x'] }]
            }
          ]
        }),
        'invalid source id'
      ]
    ];
    for (const [raw, reason] of cases) {
      let error: unknown;
      try {
        parseNewsletterOutput(raw);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(NewsletterOutputError);
      expect((error as NewsletterOutputError).reasons.join('\n')).toContain(
        reason
      );
    }
  });

  it('accepts any structurally valid document and never throws anything but NewsletterOutputError', () => {
    const sourceId = fc
      .tuple(
        fc.constantFrom('drop', 'winner', 'mint', 'identity'),
        fc.stringMatching(/^[a-z0-9:-]{1,40}$/)
      )
      .map(([kind, rest]) => `${kind}:${rest}`);
    const paragraph = fc.record({
      text: fc.stringMatching(
        /^[A-Za-z0-9]([A-Za-z0-9 ,.]{0,198}[A-Za-z0-9.])?$/
      ),
      citations: fc.array(sourceId, { maxLength: 5 })
    });
    const output = fc.record({
      sections: fc.array(
        fc.record({
          heading: fc.stringMatching(
            /^[A-Za-z0-9]([A-Za-z0-9 ]{0,48}[A-Za-z0-9])?$/
          ),
          paragraphs: fc.array(paragraph, { minLength: 1, maxLength: 4 })
        }),
        { minLength: 1, maxLength: 4 }
      ),
      winners_covered: fc.array(sourceId, { maxLength: 3 }),
      mints_covered: fc.array(sourceId, { maxLength: 3 })
    });
    fc.assert(
      fc.property(output, (document) => {
        expect(parseNewsletterOutput(JSON.stringify(document))).toEqual(
          document
        );
      })
    );
    fc.assert(
      fc.property(fc.string(), (raw) => {
        try {
          parseNewsletterOutput(raw);
        } catch (error) {
          return error instanceof NewsletterOutputError;
        }
        return true;
      })
    );
  });
});
