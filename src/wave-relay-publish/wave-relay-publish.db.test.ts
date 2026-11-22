import 'reflect-metadata';
import {
  DEVICE_GRANTS_TABLE,
  DEVICE_SIGNED_EVENTS_TABLE,
  DROP_AUTHOR_SIGNATURES_TABLE,
  DROPS_TABLE
} from '@/constants/db-tables';
import { DropType } from '@/entities/IDrop';
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

const MEMBERS = aWave(
  { visibility_group_id: 'members-group' },
  { id: 'relay-members', name: 'Members', serial_no: 3 }
);

function dropRow(id: string, waveId: string = WAVE.id) {
  return {
    id,
    serial_no: Number(id.replace(/\D/g, '')) || 1,
    wave_id: waveId,
    author_id: 'author',
    created_at: 1,
    updated_at: null,
    title: null,
    parts_count: 1,
    reply_to_drop_id: null,
    reply_to_part_id: null,
    drop_type: DropType.CHAT,
    signature: null,
    hide_link_preview: false
  };
}

describeWithSeed(
  'WaveRelayPublishDb',
  [
    withWaves([WAVE, DM, MEMBERS]),
    { table: DEVICE_GRANTS_TABLE, rows: [GRANT] },
    {
      table: DROPS_TABLE,
      rows: [
        dropRow('drop-1'),
        dropRow('drop-2'),
        dropRow('drop-3'),
        dropRow('drop-4')
      ]
    },
    {
      table: DROP_AUTHOR_SIGNATURES_TABLE,
      rows: [
        { drop_id: 'drop-1', event_id: eventId(1), signed_at: 100 },
        { drop_id: 'drop-3', event_id: eventId(3), signed_at: 300 },
        { drop_id: 'drop-4', event_id: eventId(4), signed_at: 300 }
      ]
    },
    {
      table: DEVICE_SIGNED_EVENTS_TABLE,
      rows: [
        anEvent(1, 100),
        // drop-2 was edited unsigned since: no current signature.
        anEvent(2, 200),
        // Same time: ordered by id.
        anEvent(4, 300),
        anEvent(3, 300),
        // A write still in flight (no drop yet).
        anEvent(5, 400, { drop_id: null }),
        // A delete of a drop gone.
        anEvent(8, 450, { kind: 3, drop_id: 'drop-gone' }),
        // A direct message, and a members-only wave.
        anEvent(6, 500, { wave_id: DM.id }),
        anEvent(9, 550, { wave_id: MEMBERS.id }),
        // Too recent for this read.
        anEvent(7, 10_000)
      ]
    }
  ],
  () => {
    const db = new WaveRelayPublishDb(() => sqlExecutor);
    const publicOnly = { includeMembersOnly: false };

    it('reads events after the cursor with what decides their sending', async () => {
      const read = await db.candidatesAfter(
        START_CURSOR,
        5_000,
        20,
        publicOnly
      );
      expect(
        read.map((c) => [c.event.id, c.finalized, c.dropVisible, c.dropSigned])
      ).toEqual([
        [eventId(1), true, true, true],
        [eventId(2), true, true, false],
        [eventId(3), true, true, true],
        [eventId(4), true, true, true],
        [eventId(5), false, false, false],
        [eventId(8), true, false, false]
      ]);
      expect(read[0].event).toMatchObject({
        id: eventId(1),
        kind: 1,
        wave: WAVE.id,
        auth_ref: GRANT_ID,
        body: '{"n":1}',
        created_at: 100
      });
      const page = await db.candidatesAfter(
        { createdAt: 300, eventId: eventId(3) },
        5_000,
        1,
        publicOnly
      );
      expect(page.map((c) => c.event.id)).toEqual([eventId(4)]);
      const withMembers = await db.candidatesAfter(
        { createdAt: 450, eventId: eventId(8) },
        5_000,
        20,
        { includeMembersOnly: true }
      );
      expect(withMembers.map((c) => c.event.id)).toEqual([eventId(9)]);

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
        skipped: 2,
        lastError: 'publish rate limit',
        stuckEventId: eventId(5),
        stuckCount: 3
      };
      await db.save('wss://a.example', cursor);
      expect(await db.load('wss://a.example')).toEqual(cursor);
      const cleared = {
        ...cursor,
        lastError: null,
        stuckEventId: null,
        stuckCount: 0
      };
      await db.save('wss://a.example', cleared);
      expect(await db.load('wss://a.example')).toEqual(cleared);
      expect(await db.load('wss://b.example')).toEqual(START_CURSOR);
    });
  }
);
