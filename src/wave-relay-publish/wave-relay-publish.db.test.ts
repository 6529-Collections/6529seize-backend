import 'reflect-metadata';
import {
  DEVICE_GRANTS_TABLE,
  DEVICE_SIGNED_EVENTS_TABLE
} from '@/constants/db-tables';
import { DeviceGrantEntity } from '@/entities/IDeviceGrant';
import { DeviceSignedEventEntity } from '@/entities/IDeviceSignedEvent';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { WaveRelayPublishDb } from './wave-relay-publish.db';
import { START_CURSOR } from './wave-relay-publisher';

const WALLET = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const GRANT_ID = `0x${'1'.repeat(64)}`;

const WAVE = aWave({}, { id: 'relay-wave', name: 'Wave', serial_no: 1 });
const DM = aWave(
  { is_direct_message: true },
  { id: 'relay-dm', name: 'DM', serial_no: 2 }
);

function eventId(n: number): string {
  return `0x${String(n).padStart(64, '0')}`;
}

const GRANT: DeviceGrantEntity = {
  id: GRANT_ID,
  wallet: WALLET,
  key_type: 'ed25519',
  device_key: `0x${'d'.repeat(64)}`,
  scopes: 'post,edit,delete,react',
  device_label: 'Browser',
  domain: '6529.io',
  message: 'grant message',
  wallet_signature: '0xsig',
  chain_id: 1,
  issued_at: 1,
  expires_at: 9_999_999_999,
  created_at: 1,
  revoked_at: null,
  last_used_at: 5
};

function anEvent(
  n: number,
  createdAt: number,
  overrides: Partial<DeviceSignedEventEntity> = {}
): DeviceSignedEventEntity {
  return {
    id: eventId(n),
    kind: 1,
    kind_version: 1,
    wave_id: WAVE.id,
    drop_id: `drop-${n}`,
    author: WALLET,
    profile_id: 'author',
    key_type: 2,
    device_key: GRANT.device_key,
    grant_id: GRANT_ID,
    seq: n,
    anchor: 0,
    claimed_time: createdAt,
    refs: '[]',
    body: `{"n":${n}}`,
    body_hash: `0x${'0'.repeat(64)}`,
    body_size: 7,
    signature: `0x${'e'.repeat(128)}`,
    created_at: createdAt,
    ...overrides
  };
}

describeWithSeed(
  'WaveRelayPublishDb',
  [
    withWaves([WAVE, DM]),
    { table: DEVICE_GRANTS_TABLE, rows: [GRANT] },
    {
      table: DEVICE_SIGNED_EVENTS_TABLE,
      rows: [
        anEvent(1, 100),
        anEvent(2, 200),
        // Same time: ordered by id.
        anEvent(4, 300),
        anEvent(3, 300),
        // A write still in flight (no drop yet): never published.
        anEvent(5, 400, { drop_id: null }),
        // A direct message: never published.
        anEvent(6, 500, { wave_id: DM.id }),
        // Too recent for this read.
        anEvent(7, 10_000)
      ]
    }
  ],
  () => {
    const db = new WaveRelayPublishDb(() => sqlExecutor);

    it('reads finished events of waves after the cursor, oldest first', async () => {
      const first = await db.eventsAfter(START_CURSOR, 5_000, 2);
      expect(first.map((event) => event.id)).toEqual([eventId(1), eventId(2)]);
      expect(first[0]).toMatchObject({
        id: eventId(1),
        kind: 1,
        wave: WAVE.id,
        auth_ref: GRANT_ID,
        body: '{"n":1}',
        created_at: 100
      });
      const next = await db.eventsAfter(
        { createdAt: 200, eventId: eventId(2) },
        5_000,
        10
      );
      expect(next.map((event) => event.id)).toEqual([eventId(3), eventId(4)]);
      expect(
        await db.eventsAfter({ createdAt: 300, eventId: eventId(4) }, 5_000, 10)
      ).toEqual([]);

      const grants = await db.grants([GRANT_ID, `0x${'2'.repeat(64)}`]);
      expect(Array.from(grants.keys())).toEqual([GRANT_ID]);
      expect(grants.get(GRANT_ID)).toMatchObject({
        id: GRANT_ID,
        wallet: WALLET,
        message: 'grant message',
        wallet_signature: '0xsig',
        chain_id: 1
      });
    });

    it('keeps one cursor a relay', async () => {
      expect(await db.load('wss://a.example')).toEqual(START_CURSOR);
      const cursor = {
        createdAt: 300,
        eventId: eventId(4),
        published: 4,
        rejected: 1,
        lastError: 'publish rate limit'
      };
      await db.save('wss://a.example', cursor);
      expect(await db.load('wss://a.example')).toEqual(cursor);
      await db.save('wss://a.example', { ...cursor, lastError: null });
      expect(await db.load('wss://a.example')).toEqual({
        ...cursor,
        lastError: null
      });
      expect(await db.load('wss://b.example')).toEqual(START_CURSOR);
    });
  }
);
