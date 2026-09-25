import { NewsletterCollector, discussionStart } from './newsletter-collector';
import { NewsletterDb, NewsletterDrop } from './newsletter.db';

const drop = (serial: number): NewsletterDrop => ({
  id: `drop-${serial}`,
  serial_no: serial,
  wave_id: 'wave',
  wave_name: 'Public',
  author_id: 'author',
  author_handle: 'Ayla',
  created_at: 1000,
  title: null,
  reply_to_drop_id: null
});

it('paginates beyond 500 messages without dropping equal-timestamp entries', async () => {
  const db = new NewsletterDb(() => {
    throw new Error('Unexpected SQL');
  });
  jest.spyOn(db, 'activeWaves').mockResolvedValue(['wave']);
  const recent = jest
    .spyOn(db, 'recentDrops')
    .mockResolvedValueOnce(Array.from({ length: 500 }, (_, i) => drop(i + 1)))
    .mockResolvedValueOnce([drop(501)]);
  jest.spyOn(db, 'parts').mockResolvedValue([]);
  jest.spyOn(db, 'media').mockResolvedValue([]);
  jest.spyOn(db, 'winners').mockResolvedValue([]);
  jest.spyOn(db, 'mints').mockResolvedValue([]);
  const window = { start: 1000, end: 2000, scheduled: false };
  const result = await new NewsletterCollector(db).collect(
    window,
    'destination',
    'publisher',
    {}
  );
  expect(result.sources).toHaveLength(501);
  expect(recent).toHaveBeenNthCalledWith(
    2,
    'wave',
    window,
    { createdAt: 1000, serialNo: 500 },
    'publisher',
    {}
  );
});

it('stops reply cycles and unavailable context without inventing a private root URL', () => {
  const first = { ...drop(1), reply_to_drop_id: 'drop-2' };
  const second = { ...drop(2), reply_to_drop_id: 'drop-1' };
  expect(
    discussionStart(
      first,
      new Map([
        [first.id, first],
        [second.id, second]
      ])
    )
  ).toBe(second);
  expect(discussionStart(first, new Map([[first.id, first]]))).toBe(first);
});

it('loads multi-hop public quote context once and stops at a private reference', async () => {
  const db = new NewsletterDb(() => {
    throw new Error('Unexpected SQL');
  });
  const publicContext = [drop(2), drop(3)];
  jest.spyOn(db, 'activeWaves').mockResolvedValue(['wave']);
  jest.spyOn(db, 'recentDrops').mockResolvedValue([drop(1)]);
  jest.spyOn(db, 'winners').mockResolvedValue([]);
  jest.spyOn(db, 'mints').mockResolvedValue([]);
  jest.spyOn(db, 'media').mockResolvedValue([]);
  const quotes: Record<string, string> = {
    'drop-1': 'drop-2',
    'drop-2': 'drop-3',
    'drop-3': 'private-drop'
  };
  jest.spyOn(db, 'parts').mockImplementation(async (ids) =>
    ids.map((id) => ({
      drop_id: id,
      content: `Public ${id}`,
      quoted_drop_id: quotes[id]
    }))
  );
  const context = jest
    .spyOn(db, 'contextDrops')
    .mockImplementation(async (ids) =>
      publicContext.filter((entry) => ids.includes(entry.id))
    );
  const result = await new NewsletterCollector(db).collect(
    { start: 1000, end: 2000, scheduled: false },
    'destination',
    'publisher',
    {}
  );
  expect(result.sources).toHaveLength(3);
  expect(result.sources[0].quoted_messages).toEqual([
    'https://6529.io/waves/wave?serialNo=2'
  ]);
  expect(result.sources[1].quoted_messages).toEqual([
    'https://6529.io/waves/wave?serialNo=3'
  ]);
  expect(result.sources[2].quoted_messages).toEqual([]);
  expect(context.mock.calls.map((call) => call[0])).toEqual([
    ['drop-2'],
    ['drop-3'],
    ['private-drop']
  ]);
  expect(JSON.stringify(result)).not.toContain('private-drop');
});
