import 'reflect-metadata';
import {
  DEVICE_GRANTS_TABLE,
  DEVICE_SIGNED_EVENTS_TABLE
} from '@/constants/db-tables';
import { DeviceSignedEventEntity } from '@/entities/IDeviceSignedEvent';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import {
  TEST_GRANT_ID,
  testGrantEntity
} from '@/tests/fixtures/relay-events.fixture';
import { DropIndexDb, IngestRow } from './drop-index.db';

const eventId = (n: number) => `0x${String(n).padStart(64, '0')}`;

function aRow(n: number, overrides: Partial<IngestRow> = {}): IngestRow {
  return {
    event_id: eventId(n),
    relay_id: 'r-1',
    wave: 'wave-1',
    wave_key: null,
    drop_id: `drop-${n}`,
    kind: 1,
    author: `0x${'a'.repeat(40)}`,
    device_key: `0x${'d'.repeat(64)}`,
    auth_ref: TEST_GRANT_ID,
    seq: n,
    claimed_time: 1_000 + n,
    event: { id: eventId(n), body: '{"parts":[]}' },
    grant_proof: { id: TEST_GRANT_ID },
    origin: 'relay',
    status: 'logged',
    status_reason: null,
    grant_check: 'signature',
    received_at: 5_000,
    ...overrides
  };
}

const SITE_EVENT: DeviceSignedEventEntity = {
  id: eventId(2),
  kind: 1,
  kind_version: 1,
  wave_id: 'wave-1',
  drop_id: 'site-drop',
  author: `0x${'a'.repeat(40)}`,
  profile_id: 'author',
  key_type: 2,
  device_key: `0x${'d'.repeat(64)}`,
  grant_id: TEST_GRANT_ID,
  seq: 2,
  anchor: 0,
  claimed_time: 1,
  refs: '[]',
  body: '{}',
  body_hash: `0x${'0'.repeat(64)}`,
  body_size: 2,
  signature: `0x${'e'.repeat(128)}`,
  created_at: 1
} as DeviceSignedEventEntity;

describeWithSeed(
  'DropIndexDb',
  [
    { table: DEVICE_GRANTS_TABLE, rows: [testGrantEntity()] },
    { table: DEVICE_SIGNED_EVENTS_TABLE, rows: [SITE_EVENT] }
  ],
  () => {
    const db = new DropIndexDb(() => sqlExecutor);

    it('stores each event once and returns what it stored, in its order', async () => {
      const first = await db.ingest([aRow(1), aRow(2)], 'r-1', [], 10);
      expect(first.map((e) => [e.event_id, e.ingest_seq > 0])).toEqual([
        [eventId(1), true],
        [eventId(2), true]
      ]);
      expect(first[0]).toMatchObject({
        wave: 'wave-1',
        kind: 1,
        seq: 1,
        claimed_time: 1_001,
        event: { id: eventId(1), body: '{"parts":[]}' },
        grant_proof: { id: TEST_GRANT_ID },
        origin: 'relay'
      });
      const again = await db.ingest(
        [aRow(2), aRow(3, { relay_id: 'r-2' })],
        'r-2',
        [],
        11
      );
      expect(again.map((e) => e.event_id)).toEqual([eventId(3)]);
      expect(again[0].ingest_seq).toBeGreaterThan(first[1].ingest_seq);
      const after = await db.eventsAfter(first[0].ingest_seq, 10);
      expect(after.map((e) => [e.event_id, e.relay_id])).toEqual([
        [eventId(2), 'r-1'],
        [eventId(3), 'r-2']
      ]);
      expect(await db.eventsAfter(0, 1)).toHaveLength(1);
    });

    it('moves a cursor forward within its epoch, and takes a new epoch', async () => {
      await db.ingest([], 'r-1', [{ wave: 'w', logEpoch: 1, rseq: 5 }], 1);
      await db.ingest([], 'r-1', [{ wave: 'w', logEpoch: 1, rseq: 3 }], 2);
      expect(await db.cursors('r-1')).toEqual([
        { wave: 'w', logEpoch: 1, rseq: 5 }
      ]);
      await db.ingest([], 'r-1', [{ wave: 'w', logEpoch: 2, rseq: 1 }], 3);
      await db.ingest([], 'r-1', [{ wave: 'v', logEpoch: 2, rseq: 9 }], 3);
      expect(await db.cursors('r-1')).toEqual([
        { wave: 'v', logEpoch: 2, rseq: 9 },
        { wave: 'w', logEpoch: 2, rseq: 1 }
      ]);
      expect(await db.cursors('r-2')).toEqual([]);
    });

    it('stores nothing and moves no cursor when the batch fails', async () => {
      await expect(
        db.ingest(
          [aRow(1), aRow(2, { wave: null as unknown as string })],
          'r-1',
          [{ wave: 'w', logEpoch: 1, rseq: 5 }],
          1
        )
      ).rejects.toThrow();
      expect(await db.eventsAfter(0, 10)).toEqual([]);
      expect(await db.cursors('r-1')).toEqual([]);
    });

    it('hands the relay-only events to the writer, in order, and records each outcome', async () => {
      // eventId(2) is in device_signed_events: written through 6529.io since.
      await db.ingest(
        [aRow(1), aRow(2), aRow(3), aRow(4, { origin: 'site' })],
        'r-1',
        [],
        1
      );
      expect(await db.markSiteWritten()).toBe(1);
      const pending = await db.pendingRelayEvents(10);
      expect(pending.map((e) => [e.event_id, e.apply_attempts])).toEqual([
        [eventId(1), 0],
        [eventId(3), 0]
      ]);
      await db.markApplied(pending[0].ingest_seq, 'applied', null, 'new-drop');
      await db.markApplied(pending[1].ingest_seq, 'logged', 'down', null);
      await db.markApplied(pending[1].ingest_seq, 'refused', 'no', null);
      const all = await db.eventsAfter(0, 10);
      expect(
        all.map((e) => [
          e.event_id,
          e.origin,
          e.status,
          e.status_reason,
          e.drop_id,
          e.apply_attempts
        ])
      ).toEqual([
        [eventId(1), 'relay', 'applied', null, 'new-drop', 0],
        [eventId(2), 'site', 'logged', null, 'site-drop', 0],
        [eventId(3), 'relay', 'refused', 'no', 'drop-3', 2],
        [eventId(4), 'site', 'logged', null, 'drop-4', 0]
      ]);
      expect(await db.pendingRelayEvents(10)).toEqual([]);
    });

    it('keeps rejected events out of what readers get, and finds deletes', async () => {
      await db.ingest(
        [
          aRow(1),
          aRow(2, { status: 'rejected', status_reason: 'signature' }),
          aRow(3, { kind: 3, drop_id: 'drop-x' })
        ],
        'r-1',
        [],
        1
      );
      expect((await db.eventsAfter(0, 10)).map((e) => e.event_id)).toEqual([
        eventId(1),
        eventId(3)
      ]);
      expect(await db.hasTombstone('drop-x')).toBe(true);
      expect(await db.hasTombstone('drop-1')).toBe(false);
    });

    it('releases a reservation only once it is stale and unfinished', async () => {
      await sqlExecutor.execute(
        `update ${DEVICE_SIGNED_EVENTS_TABLE} set drop_id = null, created_at = 1 where id = :id`,
        { id: eventId(2) }
      );
      await db.releaseStaleReservation(eventId(2));
      expect((await db.siteEvents([eventId(2)])).size).toBe(0);
    });

    it('finds the grants 6529.io holds and the events written through it', async () => {
      const grants = await db.knownGrants([TEST_GRANT_ID, eventId(9)]);
      expect(Array.from(grants.keys())).toEqual([TEST_GRANT_ID]);
      const site = await db.siteEvents([eventId(2), eventId(3)]);
      expect(Array.from(site.entries())).toEqual([[eventId(2), 'site-drop']]);
      expect((await db.siteEvents([])).size).toBe(0);
      const raw = await sqlExecutor.execute(
        `select count(*) as n from ${DEVICE_GRANTS_TABLE}`
      );
      expect(Number(raw[0].n)).toBe(1);
    });
  }
);
