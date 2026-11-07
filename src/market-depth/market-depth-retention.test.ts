import {
  MARKET_DEPTH_EVENT_PURGE_BATCH_SIZE,
  MARKET_DEPTH_RECONCILIATION_PURGE_BATCH_SIZE,
  MARKET_DEPTH_SNAPSHOT_PURGE_BATCH_SIZE,
  MarketDepthRetentionDb,
  marketDepthEventRetentionCutoff,
  purgeMarketDepthHistory
} from './market-depth-retention';

const NOW = new Date('2026-10-13T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60_000;
const CONTRACT = '0x33FD426905F149f8376e227d0C9D3340AaD17aF1';

function database(
  overrides: Partial<MarketDepthRetentionDb> = {}
): jest.Mocked<MarketDepthRetentionDb> {
  return {
    purgeSnapshotsCompletedBefore: jest.fn().mockResolvedValue(0),
    purgeReconciliationsDueBefore: jest.fn().mockResolvedValue(0),
    purgeEventsObservedBefore: jest
      .fn()
      .mockResolvedValue({ scanned: 0, deleted: 0, last: null }),
    ...overrides
  } as jest.Mocked<MarketDepthRetentionDb>;
}

function run(db: MarketDepthRetentionDb, deadlineMs = Infinity) {
  return purgeMarketDepthHistory({
    contract: CONTRACT,
    db,
    deadlineMs,
    now: () => NOW,
    pause: jest.fn().mockResolvedValue(undefined)
  });
}

describe('market-depth retention', () => {
  it('uses a separate window for each table, scoped to the lowercased contract', async () => {
    const db = database();
    await expect(run(db)).resolves.toEqual({
      snapshots: 0,
      reconciliations: 0,
      events: 0,
      complete: true
    });
    const contract = CONTRACT.toLowerCase();
    expect(db.purgeSnapshotsCompletedBefore).toHaveBeenCalledWith({
      contract,
      cutoff: new Date(NOW.getTime() - 14 * DAY_MS),
      limit: MARKET_DEPTH_SNAPSHOT_PURGE_BATCH_SIZE
    });
    expect(db.purgeReconciliationsDueBefore).toHaveBeenCalledWith({
      contract,
      cutoff: new Date(NOW.getTime() - 7 * DAY_MS),
      limit: MARKET_DEPTH_RECONCILIATION_PURGE_BATCH_SIZE
    });
    expect(db.purgeEventsObservedBefore).toHaveBeenCalledWith({
      contract,
      cutoff: new Date(NOW.getTime() - 30 * DAY_MS),
      after: null,
      limit: MARKET_DEPTH_EVENT_PURGE_BATCH_SIZE
    });
    expect(marketDepthEventRetentionCutoff(NOW)).toEqual(
      new Date(NOW.getTime() - 30 * DAY_MS)
    );
  });

  it('continues past kept live-order events until a short scan', async () => {
    const first = {
      observed_at: new Date('2026-09-01T00:00:00.000Z'),
      event_id: 'a'
    };
    const second = {
      observed_at: new Date('2026-09-02T00:00:00.000Z'),
      event_id: 'b'
    };
    const db = database({
      purgeEventsObservedBefore: jest
        .fn()
        // A full batch of live-order events deletes nothing but is not the end.
        .mockResolvedValueOnce({
          scanned: MARKET_DEPTH_EVENT_PURGE_BATCH_SIZE,
          deleted: 0,
          last: first
        })
        .mockResolvedValueOnce({
          scanned: MARKET_DEPTH_EVENT_PURGE_BATCH_SIZE,
          deleted: 900,
          last: second
        })
        .mockResolvedValueOnce({ scanned: 10, deleted: 10, last: null })
    });
    await expect(run(db)).resolves.toMatchObject({
      events: 910,
      complete: true
    });
    expect(
      db.purgeEventsObservedBefore.mock.calls.map(([input]) => input.after)
    ).toEqual([null, first, second]);
  });

  it('drains full batches and stops once a batch comes back short', async () => {
    const db = database({
      purgeSnapshotsCompletedBefore: jest
        .fn()
        .mockResolvedValueOnce(MARKET_DEPTH_SNAPSHOT_PURGE_BATCH_SIZE)
        .mockResolvedValueOnce(3),
      purgeReconciliationsDueBefore: jest
        .fn()
        .mockResolvedValueOnce(MARKET_DEPTH_RECONCILIATION_PURGE_BATCH_SIZE)
        .mockResolvedValueOnce(MARKET_DEPTH_RECONCILIATION_PURGE_BATCH_SIZE)
        .mockResolvedValueOnce(0)
    });
    await expect(run(db)).resolves.toEqual({
      snapshots: MARKET_DEPTH_SNAPSHOT_PURGE_BATCH_SIZE + 3,
      reconciliations: 2 * MARKET_DEPTH_RECONCILIATION_PURGE_BATCH_SIZE,
      events: 0,
      complete: true
    });
    expect(db.purgeSnapshotsCompletedBefore).toHaveBeenCalledTimes(2);
    expect(db.purgeReconciliationsDueBefore).toHaveBeenCalledTimes(3);
  });

  it('bounds each table per run so a backlog drains over several runs', async () => {
    const db = database({
      purgeReconciliationsDueBefore: jest
        .fn()
        .mockResolvedValue(MARKET_DEPTH_RECONCILIATION_PURGE_BATCH_SIZE)
    });
    await expect(run(db)).resolves.toMatchObject({
      reconciliations: 100_000,
      complete: false
    });
    expect(db.purgeReconciliationsDueBefore).toHaveBeenCalledTimes(
      100_000 / MARKET_DEPTH_RECONCILIATION_PURGE_BATCH_SIZE
    );
    // The cap is per table: events still get their turn.
    expect(db.purgeEventsObservedBefore).toHaveBeenCalledTimes(1);
  });

  it('does no work once the deadline has passed', async () => {
    const db = database();
    await expect(run(db, NOW.getTime())).resolves.toEqual({
      snapshots: 0,
      reconciliations: 0,
      events: 0,
      complete: false
    });
    expect(db.purgeSnapshotsCompletedBefore).not.toHaveBeenCalled();
    expect(db.purgeReconciliationsDueBefore).not.toHaveBeenCalled();
    expect(db.purgeEventsObservedBefore).not.toHaveBeenCalled();
  });
});
