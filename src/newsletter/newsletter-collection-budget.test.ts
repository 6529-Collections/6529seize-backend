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

it('stops a pathological quote chain without returning incomplete material', async () => {
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
  await expect(
    new NewsletterCollector(db).collect(
      { start: 0, end: 1000, scheduled: false },
      'destination',
      'publisher',
      {}
    )
  ).rejects.toThrow('context-depth budget');
  expect(context).toHaveBeenCalledTimes(100);
});
