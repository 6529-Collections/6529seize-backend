import {
  NewsletterCollectionBudget,
  NewsletterCollectionLimitError
} from './newsletter-collection-budget';
import { NewsletterCollector } from './newsletter-collector';
import { NewsletterDb, NewsletterDrop } from './newsletter.db';

afterEach(() => jest.restoreAllMocks());

it('bounds total drops and UTF-8 content before model serialization', () => {
  const rows = new NewsletterCollectionBudget();
  rows.addDrops(25_000);
  expect(() => rows.addDrops(1)).toThrow(NewsletterCollectionLimitError);
  const content = new NewsletterCollectionBudget();
  content.addContent(['界'.repeat(3_333_333)]);
  expect(() => content.addContent(['界'])).toThrow('content budget');
});

it('stops collection after two minutes and gives a distinct error', async () => {
  const now = jest.spyOn(Date, 'now').mockReturnValue(1000);
  const db = new NewsletterDb(() => {
    throw new Error('Unexpected SQL');
  });
  jest.spyOn(db, 'activeWaves').mockImplementation(async () => {
    now.mockReturnValue(121_000);
    return ['wave'];
  });
  const recent = jest.spyOn(db, 'recentDrops');
  await expect(
    new NewsletterCollector(db).collect(
      { start: 0, end: 1000, scheduled: false },
      'destination',
      'publisher',
      {}
    )
  ).rejects.toThrow('time budget');
  expect(recent).not.toHaveBeenCalled();
});

it('stops following a very long quote chain and still returns the material', async () => {
  const drop = (id: string): NewsletterDrop => ({
    id,
    serial_no: Number(id),
    wave_id: 'wave',
    wave_name: 'Public',
    author_id: 'author',
    author_handle: 'Ayla',
    created_at: 0,
    title: null,
    reply_to_drop_id: null
  });
  const db = new NewsletterDb(() => {
    throw new Error('Unexpected SQL');
  });
  jest.spyOn(db, 'activeWaves').mockResolvedValue(['wave']);
  jest.spyOn(db, 'recentDrops').mockResolvedValue([drop('1')]);
  jest.spyOn(db, 'mints').mockResolvedValue([]);
  jest.spyOn(db, 'winners').mockResolvedValue([]);
  jest.spyOn(db, 'media').mockResolvedValue([]);
  jest.spyOn(db, 'parts').mockImplementation(async (ids) =>
    ids.map((id) => ({
      drop_id: id,
      content: 'Public context',
      quoted_drop_id: String(Number(id) + 1)
    }))
  );
  const context = jest
    .spyOn(db, 'contextDrops')
    .mockImplementation(async (ids) => ids.map(drop));
  const material = await new NewsletterCollector(db).collect(
    { start: 0, end: 1000, scheduled: false },
    'destination',
    'publisher',
    {}
  );
  expect(context).toHaveBeenCalledTimes(100);
  expect(material.sources.length).toBeGreaterThan(1);
});

function drop(
  id: string,
  waveId = 'wave',
  authorId = 'author'
): NewsletterDrop {
  return {
    id,
    serial_no: Number(id.replace(/\D/g, '')) || 0,
    wave_id: waveId,
    wave_name: waveId,
    author_id: authorId,
    author_handle: authorId,
    created_at: 0,
    title: null,
    reply_to_drop_id: null
  };
}

const SMALL_SHARES = {
  maxDropsPerWave: 3,
  maxDropsPerAuthor: 2,
  maxContentBytesPerWave: 10,
  maxContentBytesPerAuthor: 6
};

it('keeps each wave and author within its share of drops', () => {
  const budget = new NewsletterCollectionBudget(SMALL_SHARES);
  const admitted = budget.admitDrops([
    drop('1', 'busy', 'a'),
    drop('2', 'busy', 'a'),
    drop('3', 'busy', 'a'),
    drop('4', 'busy', 'b'),
    drop('5', 'busy', 'c'),
    drop('6', 'quiet', 'a')
  ]);
  expect(admitted.map((item) => item.id)).toEqual(['1', '2', '4']);
  expect(budget.isWaveFull('busy')).toBe(true);
  expect(budget.isWaveFull('quiet')).toBe(false);
  expect(budget.truncationSummary()).toEqual(
    expect.objectContaining({
      droppedDropsByWave: { busy: 1 },
      droppedDropsByAuthor: { a: 2 }
    })
  );
});

it('cuts text past a wave or author content share at a character boundary', () => {
  const budget = new NewsletterCollectionBudget(SMALL_SHARES);
  const owner = { wave_id: 'wave', author_id: 'author' };
  expect(budget.admitText(owner, 'abcd')).toBe('abcd');
  expect(budget.admitText(owner, '\u754c\u754c')).toBe('');
  expect(budget.admitText(owner, 'xyz')).toBe('xy');
  expect(budget.admitText(owner, 'more')).toBe('');
  expect(
    budget.admitText({ wave_id: 'wave', author_id: 'other' }, 'abcdef')
  ).toBe('abcd');
  expect(budget.truncationSummary()?.truncatedContentBytes).toBe(13);
});

it('publishes material from a wave that exceeds its share instead of failing', async () => {
  const db = new NewsletterDb(() => {
    throw new Error('Unexpected SQL');
  });
  jest.spyOn(db, 'activeWaves').mockResolvedValue(['busy', 'quiet']);
  const recent = jest
    .spyOn(db, 'recentDrops')
    .mockImplementation(async (waveId, _window, after) => {
      if (waveId === 'quiet') return [drop('q1', 'quiet', 'q')];
      const offset = after.serialNo;
      return Array.from({ length: 500 }, (_, index) => ({
        ...drop(String(offset + index + 1), 'busy', `author-${index % 50}`),
        serial_no: offset + index + 1
      }));
    });
  jest.spyOn(db, 'winners').mockResolvedValue([]);
  jest.spyOn(db, 'mints').mockResolvedValue([]);
  jest.spyOn(db, 'media').mockResolvedValue([]);
  jest.spyOn(db, 'parts').mockResolvedValue([]);
  jest.spyOn(db, 'contextDrops').mockResolvedValue([]);

  const material = await new NewsletterCollector(
    db,
    () =>
      new NewsletterCollectionBudget({
        ...SMALL_SHARES,
        maxDropsPerWave: 600,
        maxDropsPerAuthor: 1000
      })
  ).collect(
    { start: 0, end: 1000, scheduled: false },
    'destination',
    'publisher',
    {}
  );

  const busy = material.sources.filter((source) => source.wave === 'busy');
  expect(busy).toHaveLength(600);
  expect(material.sources.some((source) => source.wave === 'quiet')).toBe(true);
  expect(
    recent.mock.calls.filter(([waveId]) => waveId === 'busy')
  ).toHaveLength(2);
});
