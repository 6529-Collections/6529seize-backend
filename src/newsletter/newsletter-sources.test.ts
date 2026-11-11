import fc from 'fast-check';
import {
  NewsletterDrop,
  NewsletterMint,
  NewsletterWinner
} from './newsletter.db';
import {
  buildSourceRegistry,
  contentFingerprint,
  dropSourceId,
  identitySourceId,
  mintSourceId,
  SOURCE_ID_PATTERN,
  winnerSourceId
} from './newsletter-sources';

const drop = (id: string, created_at: number): NewsletterDrop => ({
  id,
  serial_no: 7,
  wave_id: 'wave',
  wave_name: 'Public',
  author_id: 'author',
  author_handle: 'Ayla',
  created_at,
  title: null,
  reply_to_drop_id: null
});
const uuid = fc.uuid();

describe('newsletter source ids', () => {
  it('derives deterministic ids that match the accepted pattern', () => {
    fc.assert(
      fc.property(uuid, uuid, uuid, fc.nat(10_000), (a, b, c, card) => {
        const ids = [
          dropSourceId(a),
          winnerSourceId({ id: a, competition_id: b, entry_id: c }),
          winnerSourceId({ id: a, competition_id: null, entry_id: null }),
          mintSourceId('The Memes', card),
          mintSourceId('Meme Lab', card),
          identitySourceId(a)
        ];
        return (
          ids.every((id) => SOURCE_ID_PATTERN.test(id)) &&
          ids[0] === `drop:${a}` &&
          ids[1] === `winner:${b}:${c}` &&
          ids[2] === `drop:${a}` &&
          ids[3] === `mint:the-memes:${card}` &&
          ids[4] === `mint:meme-lab:${card}` &&
          ids[5] === `identity:${a}`
        );
      })
    );
  });

  it('rejects ids with link syntax or whitespace', () => {
    for (const id of [
      'drop:',
      'drop:a b',
      'drop:[x](y)',
      'https://6529.io',
      'other:1'
    ]) {
      expect(SOURCE_ID_PATTERN.test(id)).toBe(false);
    }
  });
});

describe('newsletter source registry', () => {
  const winner: NewsletterWinner = {
    ...drop('win', 500),
    wave_id: 'stage',
    decision_time: 1500,
    ranking: 1,
    competition_id: 'contest',
    entry_id: 'entry'
  };
  const mint: NewsletterMint = {
    collection: 'The Memes',
    id: 552,
    name: 'Card',
    artist_seize_handle: 'Ayla',
    mint_date: null,
    first_mint_in_window: new Date(1200).toISOString(),
    minted_count: 3
  };
  const registry = () =>
    buildSourceRegistry({
      drops: new Map([
        ['a', drop('a', 1000)],
        ['old', drop('old', 999)],
        ['win', winner]
      ]),
      parts: new Map([
        [
          'a',
          [
            {
              drop_id: 'a',
              content: 'Visit https://evil.example now',
              quoted_drop_id: null
            }
          ]
        ]
      ]),
      media: new Map(),
      winners: [winner],
      mints: [mint],
      windowStart: 1000,
      observedAt: 5000
    });

  it('is populated only from rows, preserving observation times, event times and fingerprints', () => {
    const records = registry();
    expect(
      Array.from(records.keys()).sort((x, y) => x.localeCompare(y))
    ).toEqual([
      'drop:a',
      'drop:old',
      'drop:win',
      'identity:author',
      'mint:the-memes:552',
      'winner:contest:entry'
    ]);
    expect(records.get('drop:a')).toEqual({
      source_id: 'drop:a',
      kind: 'DROP',
      canonical_url: 'https://6529.io/waves/wave?serialNo=7',
      title: null,
      author_handle: 'Ayla',
      wave_id: 'wave',
      wave_name: 'Public',
      observed_at: '1970-01-01T00:00:05.000Z',
      content_fingerprint: contentFingerprint({
        title: null,
        text: ['Visit https://evil.example now'],
        quoted: [null],
        media: []
      }),
      time: '1970-01-01T00:00:01.000Z',
      context_only: false,
      drop_id: 'a',
      team_wave: false
    });
    expect(records.get('drop:old')?.context_only).toBe(true);
    expect(records.get('winner:contest:entry')).toMatchObject({
      kind: 'WINNER',
      time: '1970-01-01T00:00:01.500Z',
      canonical_url:
        'https://6529.io/waves/stage/competitions/contest?entry=entry',
      drop_id: 'win'
    });
    expect(records.get('mint:the-memes:552')).toMatchObject({
      kind: 'MINT',
      time: '1970-01-01T00:00:01.200Z',
      canonical_url: 'https://6529.io/the-memes/552'
    });
    expect(records.get('identity:author')).toMatchObject({
      kind: 'IDENTITY',
      context_only: true,
      canonical_url: 'https://6529.io/Ayla'
    });
    // Text inside a message is data: it never becomes a URL of any record.
    for (const record of Array.from(records.values())) {
      expect(record.canonical_url).toMatch(/^https:\/\/6529\.io\//);
    }
  });

  it('changes the fingerprint when collected text changes', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        const same =
          contentFingerprint({ text: [a] }) ===
          contentFingerprint({ text: [b] });
        return (
          same === (a === b) &&
          /^[a-f0-9]{64}$/.test(contentFingerprint({ text: [a] }))
        );
      })
    );
  });
});
