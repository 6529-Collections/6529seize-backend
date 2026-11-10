import { Wallet } from 'ethers';
import { NewsletterEditionStatus } from '@/entities/INewsletterEdition';
import { NewsletterCollection } from './newsletter-collector';
import { NewsletterOutput } from './newsletter-output.schema';
import { SourceRecord } from './newsletter-sources';
import { publishNewsletter } from './newsletter.service';

const config = {
  waveId: 'destination',
  wallet: new Wallet('0x' + '12'.repeat(32)),
  modelId: 'test-model'
};
const window = {
  start: Date.parse('2026-09-23T00:00:00Z'),
  end: Date.parse('2026-09-24T00:00:00Z'),
  scheduled: true
};
const mintRecord: SourceRecord = {
  source_id: 'mint:the-memes:552',
  kind: 'MINT',
  canonical_url: 'https://6529.io/the-memes/552',
  title: 'Test card',
  author_handle: null,
  wave_id: null,
  wave_name: null,
  observed_at: new Date(window.end).toISOString(),
  content_fingerprint: 'a'.repeat(64),
  time: new Date(window.start).toISOString(),
  context_only: false,
  drop_id: null,
  team_wave: false
};
const collection: NewsletterCollection = {
  material: {
    window: {
      start: new Date(window.start).toISOString(),
      end: new Date(window.end).toISOString()
    },
    sources: [],
    winners: [],
    mints: [
      {
        source_id: 'mint:the-memes:552',
        collection: 'The Memes',
        card: 552,
        title: 'Test card',
        url: 'https://6529.io/the-memes/552',
        artists: [],
        first_mint: null,
        first_mint_in_window: new Date(window.start).toISOString(),
        minted_count: 1
      }
    ]
  },
  registry: new Map([[mintRecord.source_id, mintRecord]])
};
const validOutput: NewsletterOutput = {
  sections: [
    {
      heading: 'Mints',
      paragraphs: [
        { text: 'Test card kept minting.', citations: ['mint:the-memes:552'] }
      ]
    }
  ],
  winners_covered: [],
  mints_covered: ['mint:the-memes:552']
};

function dependencies(raw = JSON.stringify(validOutput)) {
  return {
    db: {
      publishedEdition: jest.fn().mockResolvedValue(null),
      findEdition: jest.fn().mockResolvedValue(null),
      saveEdition: jest.fn().mockResolvedValue(undefined)
    },
    collector: { collect: jest.fn().mockResolvedValue(collection) },
    writer: { write: jest.fn().mockResolvedValue(raw) },
    publisher: {
      authorId: jest.fn().mockResolvedValue('publisher'),
      publish: jest.fn().mockResolvedValue('new-drop')
    }
  };
}

describe('newsletter publication', () => {
  it('skips a committed scheduled edition before collection or generation', async () => {
    const deps = dependencies();
    deps.db.publishedEdition.mockResolvedValue('existing');
    expect(await publishNewsletter(config, window, {}, deps)).toEqual({
      status: 'already-published',
      dropId: 'existing'
    });
    expect(deps.db.publishedEdition).toHaveBeenCalledWith(
      'daily:2026-09-23',
      'destination',
      'publisher',
      {}
    );
    expect(deps.collector.collect).not.toHaveBeenCalled();
    expect(deps.writer.write).not.toHaveBeenCalled();
    expect(deps.publisher.publish).not.toHaveBeenCalled();
    expect(deps.db.saveEdition).not.toHaveBeenCalled();
  });

  it('also skips when the edition row is already PUBLISHED and writes no second row', async () => {
    const deps = dependencies();
    deps.db.findEdition.mockResolvedValue({
      edition_id: 'daily:2026-09-23',
      status: NewsletterEditionStatus.Published,
      drop_id: 'row-drop'
    });
    expect(await publishNewsletter(config, window, {}, deps)).toEqual({
      status: 'already-published',
      dropId: 'row-drop'
    });
    expect(deps.db.findEdition).toHaveBeenCalledWith('daily:2026-09-23', {});
    expect(deps.publisher.publish).not.toHaveBeenCalled();
    expect(deps.db.saveEdition).not.toHaveBeenCalled();
  });

  it('always publishes a fresh edition for manual invocations, even after a daily edition', async () => {
    const deps = dependencies();
    deps.db.publishedEdition.mockResolvedValue('existing');
    const manual = { ...window, scheduled: false };
    await publishNewsletter(config, manual, {}, deps);
    await publishNewsletter(config, manual, {}, deps);
    expect(deps.db.publishedEdition).not.toHaveBeenCalled();
    expect(deps.db.findEdition).not.toHaveBeenCalled();
    expect(deps.publisher.publish).toHaveBeenCalledTimes(2);
    const ids = deps.publisher.publish.mock.calls.map((call) => call[1]);
    expect(ids[0]).toMatch(/^manual:/);
    expect(ids[0]).not.toBe(ids[1]);
    expect(deps.collector.collect).toHaveBeenCalledWith(
      manual,
      'destination',
      'publisher',
      {}
    );
    expect(deps.db.saveEdition.mock.calls.map((call) => call[0].mode)).toEqual([
      'manual',
      'manual'
    ]);
  });

  it('does not publish when there is no activity or generation fails', async () => {
    const deps = dependencies();
    deps.collector.collect.mockResolvedValueOnce({
      ...collection,
      material: { ...collection.material, mints: [] }
    });
    expect(await publishNewsletter(config, window, {}, deps)).toEqual({
      status: 'no-public-activity'
    });
    deps.writer.write.mockRejectedValue(new Error('model timed out'));
    await expect(publishNewsletter(config, window, {}, deps)).rejects.toThrow(
      'model timed out'
    );
    expect(deps.publisher.publish).not.toHaveBeenCalled();
    expect(deps.db.saveEdition).not.toHaveBeenCalled();
  });

  it('publishes validated output with registry links only and persists PUBLISHED', async () => {
    const deps = dependencies();
    expect(await publishNewsletter(config, window, {}, deps)).toEqual({
      status: 'published',
      dropId: 'new-drop'
    });
    const [waveId, editionId, markdown] = deps.publisher.publish.mock.calls[0];
    expect(waveId).toBe('destination');
    expect(editionId).toBe('daily:2026-09-23');
    expect(markdown).toContain('## 6529 Daily Post — 2026-09-23');
    expect(markdown).toContain('Test card kept minting.');
    expect(markdown.match(/https?:\/\/[^)\s]+/g)).toEqual([
      'https://6529.io/the-memes/552'
    ]);
    expect(deps.db.saveEdition).toHaveBeenCalledTimes(1);
    expect(deps.db.saveEdition.mock.calls[0][0]).toEqual({
      edition_id: 'daily:2026-09-23',
      status: 'PUBLISHED',
      window_start: window.start,
      window_end: window.end,
      mode: 'scheduled',
      drop_id: 'new-drop',
      raw_output: JSON.stringify(validOutput),
      rejection_reasons: null,
      sources: [mintRecord]
    });
  });

  it.each([
    [
      'an invented drop link in the text',
      JSON.stringify({
        ...validOutput,
        sections: [
          {
            heading: 'Mints',
            paragraphs: [
              {
                text: 'See https://6529.io/waves/x?serialNo=1 for Test card.',
                citations: ['mint:the-memes:552']
              }
            ]
          }
        ]
      }),
      'text contains a URL or Markdown link'
    ],
    [
      'an unknown source id',
      JSON.stringify({
        ...validOutput,
        sections: [
          {
            heading: 'Mints',
            paragraphs: [
              {
                text: 'Test card kept minting.',
                citations: ['mint:the-memes:552', 'drop:invented']
              }
            ]
          }
        ]
      }),
      'unknown source id "drop:invented"'
    ],
    [
      'free-form Markdown instead of JSON',
      '## A linked newsletter',
      'malformed output'
    ],
    [
      'an oversized edition',
      JSON.stringify({
        ...validOutput,
        sections: [
          {
            heading: 'Mints',
            paragraphs: Array.from({ length: 10 }, () => ({
              text: 'x'.repeat(3_000),
              citations: ['mint:the-memes:552']
            }))
          }
        ]
      }),
      'does not fit in one drop'
    ]
  ])(
    'rejects %s: nothing is published and a REJECTED row keeps the draft and reasons',
    async (_, raw, reason) => {
      const deps = dependencies(raw);
      const result = await publishNewsletter(config, window, {}, deps);
      expect(result.status).toBe('rejected-unverified');
      expect(result.dropId).toBeUndefined();
      expect(result.reasons?.join('\n')).toContain(reason);
      expect(deps.publisher.publish).not.toHaveBeenCalled();
      expect(deps.db.saveEdition).toHaveBeenCalledTimes(1);
      expect(deps.db.saveEdition.mock.calls[0][0]).toEqual({
        edition_id: 'daily:2026-09-23',
        status: 'REJECTED',
        window_start: window.start,
        window_end: window.end,
        mode: 'scheduled',
        drop_id: null,
        raw_output: raw,
        rejection_reasons: result.reasons,
        sources: [mintRecord]
      });
    }
  );

  it('lets a scheduled retry after a rejection run again instead of treating it as published', async () => {
    const deps = dependencies();
    deps.db.findEdition.mockResolvedValue({
      edition_id: 'daily:2026-09-23',
      status: NewsletterEditionStatus.Rejected,
      drop_id: null
    });
    expect(await publishNewsletter(config, window, {}, deps)).toMatchObject({
      status: 'published'
    });
    expect(deps.db.saveEdition.mock.calls[0][0].status).toBe('PUBLISHED');
  });
});
