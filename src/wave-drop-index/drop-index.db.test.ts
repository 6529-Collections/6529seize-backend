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
import {
  DropIndexDb,
  IngestRow,
  PENDING_PER_AUTHOR,
  RejectRow
} from './drop-index.db';

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
    grant_revoked_at: null,
    received_at: 5_000,
    ...overrides
  };
}

function aReject(n: number, overrides: Partial<RejectRow> = {}): RejectRow {
  return {
    event_id: eventId(n),
    relay_id: 'r-9',
    wave: 'wave-1',
    reason: 'signature',
    event: { id: eventId(n), body: '{"forged":true}' },
    grant_proof: { id: TEST_GRANT_ID },
    received_at: 4_000,
    ...overrides
  };
}

const AUTHOR = `0x${'a'.repeat(40)}`;
const NOW = 10_000;

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
      const first = await db.ingest([aRow(1), aRow(2)], [], 'r-1', [], 10);
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
        origin: 'relay',
        grant_revoked_at: null
      });
      const again = await db.ingest(
        [aRow(2), aRow(3, { relay_id: 'r-2' })],
        [],
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
      await db.ingest([], [], 'r-1', [{ wave: 'w', logEpoch: 1, rseq: 5 }], 1);
      await db.ingest([], [], 'r-1', [{ wave: 'w', logEpoch: 1, rseq: 3 }], 2);
      expect(await db.cursors('r-1')).toEqual([
        { wave: 'w', logEpoch: 1, rseq: 5 }
      ]);
      await db.ingest([], [], 'r-1', [{ wave: 'w', logEpoch: 2, rseq: 1 }], 3);
      await db.ingest([], [], 'r-1', [{ wave: 'v', logEpoch: 2, rseq: 9 }], 3);
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
          [],
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
        [],
        'r-1',
        [],
        1
      );
      expect(await db.markSiteWritten()).toBe(1);
      const pending = await db.pendingRelayEvents(10, NOW);
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
      expect(await db.pendingRelayEvents(10, NOW)).toEqual([]);
    });

    it('keeps a bad copy apart, so the valid copy of the same id is stored', async () => {
      // A relay sends a forged copy under eventId(2) first.
      const first = await db.ingest(
        [aRow(1)],
        [aReject(2), aReject(7, { event_id: null, reason: 'unreadable' })],
        'r-9',
        [],
        1
      );
      expect(first.map((e) => e.event_id)).toEqual([eventId(1)]);
      // Another relay then sends the genuine one.
      const second = await db.ingest(
        [aRow(2, { relay_id: 'r-1', grant_revoked_at: 1_500 })],
        [],
        'r-1',
        [],
        2
      );
      expect(second.map((e) => [e.event_id, e.relay_id])).toEqual([
        [eventId(2), 'r-1']
      ]);
      expect(second[0].grant_revoked_at).toBe(1_500);
      expect(second[0].event).toEqual({
        id: eventId(2),
        body: '{"parts":[]}'
      });
      const rejects = await db.rejectsAfter(0, 10);
      expect(
        rejects.map((r) => [r.event_id, r.relay_id, r.reason, r.event])
      ).toEqual([
        [
          eventId(2),
          'r-9',
          'signature',
          { id: eventId(2), body: '{"forged":true}' }
        ],
        [null, 'r-9', 'unreadable', { id: eventId(7), body: '{"forged":true}' }]
      ]);
      expect(await db.rejectsAfter(rejects[0].id, 10)).toHaveLength(1);
      expect((await db.eventsAfter(0, 10)).map((e) => e.event_id)).toEqual([
        eventId(1),
        eventId(2)
      ]);
    });

    it("finds a delete only when it is by the post's author", async () => {
      await db.ingest(
        [
          aRow(1),
          aRow(3, { kind: 3, drop_id: 'drop-x' }),
          aRow(4, { kind: 3, drop_id: 'drop-y', author: `0x${'b'.repeat(40)}` })
        ],
        [],
        'r-1',
        [],
        1
      );
      expect(await db.hasTombstone('drop-x', AUTHOR)).toBe(true);
      expect(await db.hasTombstone('drop-x', AUTHOR.toUpperCase())).toBe(true);
      expect(await db.hasTombstone('drop-y', AUTHOR)).toBe(false);
      expect(await db.hasTombstone('drop-1', AUTHOR)).toBe(false);
    });

    it('lets an event wait without counting a try, and its drop waits with it', async () => {
      // 1 and 2 are a post and its edit (drop-1); 3 is another drop.
      await db.ingest(
        [aRow(1), aRow(2, { kind: 2, drop_id: 'drop-1' }), aRow(3)],
        [],
        'r-1',
        [],
        1
      );
      const [first] = await db.pendingRelayEvents(10, NOW);
      await db.markApplied(first.ingest_seq, 'waiting', 'no post', null, 500);
      await db.markApplied(first.ingest_seq, 'waiting', 'no post', null, 600);
      // Until 600 neither the waiting event nor its drop's edit is taken.
      expect(
        (await db.pendingRelayEvents(10, 599)).map((e) => e.event_id)
      ).toEqual([eventId(3)]);
      const due = await db.pendingRelayEvents(10, 600);
      expect(due.map((e) => e.event_id)).toEqual([
        eventId(1),
        eventId(2),
        eventId(3)
      ]);
      expect([
        due[0].status,
        due[0].status_reason,
        due[0].apply_attempts
      ]).toEqual(['logged', 'no post', 0]);
      // Any other outcome clears the wait.
      await db.markApplied(first.ingest_seq, 'logged', 'down', null, 9_999);
      expect(
        (await db.pendingRelayEvents(10, 0)).map((e) => e.event_id)
      ).toEqual([eventId(1), eventId(2), eventId(3)]);
    });

    it("takes at most a share of one author's events in a batch", async () => {
      const many = Array.from({ length: PENDING_PER_AUTHOR + 2 }, (_, i) =>
        aRow(i + 1)
      );
      const other = aRow(99, { author: `0x${'b'.repeat(40)}` });
      await db.ingest([...many, other], [], 'r-1', [], 1);
      const batch = await db.pendingRelayEvents(100, NOW);
      expect(batch).toHaveLength(PENDING_PER_AUTHOR + 1);
      expect(batch.map((e) => e.event_id)).toEqual([
        ...many.slice(0, PENDING_PER_AUTHOR).map((r) => r.event_id),
        eventId(99)
      ]);
      expect(await db.pendingRelayEvents(5, NOW)).toHaveLength(5);
    });

    it('keeps half of each batch for events never tried, behind their drop', async () => {
      const b = `0x${'b'.repeat(40)}`;
      await db.ingest(
        [
          aRow(1),
          aRow(2),
          aRow(3),
          aRow(4, { author: b }),
          // b's reaction to drop-2, an earlier event still pending.
          aRow(5, { author: b, kind: 4, drop_id: 'drop-2' })
        ],
        [],
        'r-1',
        [],
        1
      );
      const tried = await db.pendingRelayEvents(3, NOW);
      for (const event of tried) {
        await db.markApplied(event.ingest_seq, 'logged', 'down', null);
      }
      // Without the kept half, a's tried events would fill the batch.
      expect(
        (await db.pendingRelayEvents(2, NOW)).map((e) => e.event_id)
      ).toEqual([eventId(1), eventId(4)]);
      // A never-tried event never jumps an earlier pending one of its drop.
      expect(
        (await db.pendingRelayEvents(4, NOW)).map((e) => e.event_id)
      ).toEqual([eventId(1), eventId(2), eventId(3), eventId(4)]);
      expect(
        (await db.pendingRelayEvents(10, NOW)).map((e) => e.event_id)
      ).toEqual([eventId(1), eventId(2), eventId(3), eventId(4), eventId(5)]);
    });

    it('releases a reservation only once it is stale and unfinished', async () => {
      await sqlExecutor.execute(
        `update ${DEVICE_SIGNED_EVENTS_TABLE} set drop_id = null, created_at = 1 where id = :id`,
        { id: eventId(2) }
      );
      expect(await db.hasPendingReservation(eventId(2))).toBe(true);
      expect(await db.hasPendingReservation(eventId(9))).toBe(false);
      await db.releaseStaleReservation(eventId(2));
      expect((await db.siteEvents([eventId(2)])).size).toBe(0);
      expect(await db.hasPendingReservation(eventId(2))).toBe(false);
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
