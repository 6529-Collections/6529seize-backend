import { artworkDocumentationDb } from '@/artwork-documentation/artwork-documentation.db';
import { processOldestDocumentationJob } from './artwork-documentation-queue';

afterEach(() => jest.restoreAllMocks());

function processors() {
  return {
    asset: { tick: jest.fn(async () => true) },
    dossier: { tick: jest.fn(async () => true) }
  };
}

it('processes an older upload on repeated even-minute invocations after long exports', async () => {
  const work = processors();
  const one = jest
    .spyOn(artworkDocumentationDb, 'one')
    .mockResolvedValueOnce({ queue: 'dossier' })
    .mockResolvedValueOnce({ queue: 'asset' });
  const start = 2 * 60_000;
  // A nearly twelve-minute export plus the next scheduled trigger lands on
  // another even minute. That clock parity must not override the next head.
  await processOldestDocumentationJob(work, artworkDocumentationDb, start);
  expect(work.dossier.tick).toHaveBeenCalledTimes(1);
  expect(work.asset.tick).not.toHaveBeenCalled();
  await processOldestDocumentationJob(
    work,
    artworkDocumentationDb,
    start + 12 * 60_000
  );
  expect(work.asset.tick).toHaveBeenCalledTimes(1);
  expect(work.dossier.tick).toHaveBeenCalledTimes(1);
  expect(one.mock.calls.map((call) => call[1])).toEqual([
    { now: start },
    { now: start + 12 * 60_000 }
  ]);
});

it('excludes future retries, active leases and expired or exhausted exports before ordering', async () => {
  const one = jest
    .spyOn(artworkDocumentationDb, 'one')
    .mockResolvedValue({ queue: 'asset' });
  await processOldestDocumentationJob(processors(), artworkDocumentationDb, 99);
  const sql = one.mock.calls[0][0].replace(/\s+/g, ' ');
  expect(sql).toContain(
    "WHERE state='processing' AND next_attempt_at<=:now AND lease_until<:now"
  );
  expect(sql).toContain(
    "WHERE state IN ('queued','processing') AND lease_until<:now AND expires_at>:now AND attempts<3"
  );
  expect(sql).toContain('ORDER BY next_attempt_at,id LIMIT 1');
  expect(sql).toContain('ORDER BY created_at,id LIMIT 1');
  expect(sql).toContain('ORDER BY queued_at,queue,id LIMIT 1');
  expect(one.mock.calls[0][1]).toEqual({ now: 99 });
});

it.each(['asset', 'dossier'] as const)(
  'falls back sequentially when the %s claim loses a race',
  async (first) => {
    jest
      .spyOn(artworkDocumentationDb, 'one')
      .mockResolvedValue({ queue: first });
    const work = processors();
    const second = first === 'asset' ? 'dossier' : 'asset';
    work[first].tick.mockImplementationOnce(async () => {
      expect(work[second].tick).not.toHaveBeenCalled();
      return false;
    });
    await processOldestDocumentationJob(work);
    expect(work[first].tick).toHaveBeenCalledTimes(1);
    expect(work[second].tick).toHaveBeenCalledTimes(1);
  }
);

it('retains asset cleanup and export lease maintenance when both queues are empty', async () => {
  jest.spyOn(artworkDocumentationDb, 'one').mockResolvedValue(null);
  const work = processors();
  work.asset.tick.mockResolvedValue(false);
  work.dossier.tick.mockResolvedValue(false);
  await processOldestDocumentationJob(work);
  expect(work.asset.tick).toHaveBeenCalledTimes(1);
  expect(work.dossier.tick).toHaveBeenCalledTimes(1);
});

it('does not start another long job after a claimed job fails', async () => {
  jest
    .spyOn(artworkDocumentationDb, 'one')
    .mockResolvedValue({ queue: 'dossier' });
  const work = processors();
  work.dossier.tick.mockRejectedValue(new Error('worker unavailable'));
  await expect(processOldestDocumentationJob(work)).rejects.toThrow(
    'worker unavailable'
  );
  expect(work.asset.tick).not.toHaveBeenCalled();
});
