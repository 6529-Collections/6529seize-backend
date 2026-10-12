import 'reflect-metadata';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import {
  anAddressConsolidationKeys,
  withAddressConsolidationKeys
} from '@/tests/fixtures/address-consolidation-key.fixture';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import { DeviceGrantEntity } from '@/entities/IDeviceGrant';
import { DeviceSignedEventEntity } from '@/entities/IDeviceSignedEvent';
import { RequestContext } from '@/request.context';
import { DeviceSigningDb } from './device-signing.db';

const WALLET_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const WALLET_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const WALLET_C = '0xcccccccccccccccccccccccccccccccccccccccc';
const PROFILE_ID = 'device-signing-profile';
const consolidation = anAddressConsolidationKeys([WALLET_A, WALLET_B]);

function hex(char: string, length: number): string {
  return `0x${char.repeat(length)}`;
}

function aGrant(
  id: string,
  wallet: string,
  createdAt: number
): DeviceGrantEntity {
  return {
    id,
    wallet,
    key_type: 'ed25519',
    device_key: hex('d', 64),
    scopes: 'post,edit,delete,react',
    device_label: 'Browser',
    domain: '6529.io',
    message: `message ${id}`,
    wallet_signature: '0xsig',
    chain_id: 1,
    issued_at: createdAt,
    expires_at: createdAt + 1000,
    created_at: createdAt,
    revoked_at: null,
    last_used_at: null
  };
}

function anEvent(
  id: string,
  seq: number,
  overrides: Partial<DeviceSignedEventEntity> = {}
): DeviceSignedEventEntity {
  return {
    id,
    kind: 1,
    kind_version: 1,
    wave_id: 'wave-1',
    drop_id: null,
    author: WALLET_A,
    profile_id: PROFILE_ID,
    key_type: 2,
    device_key: hex('d', 64),
    grant_id: hex('1', 64),
    seq,
    anchor: 0,
    claimed_time: 1760000000123,
    refs: '[]',
    body: '{"a":"é😀"}',
    body_hash: hex('0', 64),
    body_size: 11,
    signature: hex('e', 128),
    created_at: seq,
    ...overrides
  };
}

describeWithSeed(
  'DeviceSigningDb',
  [
    withAddressConsolidationKeys(consolidation),
    withIdentities([
      anIdentity(
        {},
        {
          consolidation_key: consolidation[0].consolidation_key,
          profile_id: PROFILE_ID,
          primary_address: WALLET_A,
          handle: 'devicesigner'
        }
      )
    ])
  ],
  () => {
    const repo = new DeviceSigningDb(() => sqlExecutor);
    const ctx: RequestContext = { timer: undefined };

    it('inserts grants idempotently', async () => {
      const grant = aGrant(hex('1', 64), WALLET_A, 1);
      await expect(repo.insertGrant(grant, ctx)).resolves.toBe(true);
      await expect(
        repo.insertGrant({ ...grant, device_label: 'Other' }, ctx)
      ).resolves.toBe(false);
      const stored = await repo.findGrantById(grant.id, ctx);
      expect(stored).toMatchObject({ ...grant, device_label: 'Browser' });
      expect(Number(stored!.expires_at)).toBe(1001);
    });

    it('lists grants of every wallet of the profile, newest first', async () => {
      await repo.insertGrant(aGrant(hex('1', 64), WALLET_A, 1), ctx);
      await repo.insertGrant(aGrant(hex('2', 64), WALLET_B, 2), ctx);
      await repo.insertGrant(aGrant(hex('3', 64), WALLET_C, 3), ctx);

      const profileGrants = await repo.findGrantsOfProfile(PROFILE_ID, ctx);
      expect(profileGrants.map((it) => it.id)).toEqual([
        hex('2', 64),
        hex('1', 64)
      ]);
      const walletGrants = await repo.findGrantsOfWallet(WALLET_C, ctx);
      expect(walletGrants.map((it) => it.id)).toEqual([hex('3', 64)]);
      const byIds = await repo.findGrantsByIds(
        [hex('3', 64), hex('1', 64)],
        ctx
      );
      expect(byIds.map((it) => it.id)).toEqual([hex('1', 64), hex('3', 64)]);
    });

    it('keeps the first revocation time and bumps last use', async () => {
      const id = hex('1', 64);
      await repo.insertGrant(aGrant(id, WALLET_A, 1), ctx);
      await repo.revokeGrant(id, 10, ctx);
      await repo.revokeGrant(id, 20, ctx);
      await repo.touchGrantLastUsed(id, 30, ctx);

      const stored = await repo.findGrantById(id, ctx);
      expect(Number(stored!.revoked_at)).toBe(10);
      expect(Number(stored!.last_used_at)).toBe(30);
    });

    it('rejects reused event ids and reused (device key, seq)', async () => {
      await expect(
        repo.reserveEvent(anEvent(hex('a', 64), 1), ctx)
      ).resolves.toBe(true);
      await expect(
        repo.reserveEvent(anEvent(hex('a', 64), 2), ctx)
      ).resolves.toBe(false);
      await expect(
        repo.reserveEvent(anEvent(hex('b', 64), 1), ctx)
      ).resolves.toBe(false);
      await expect(
        repo.reserveEvent(
          anEvent(hex('b', 64), 1, { device_key: hex('f', 64) }),
          ctx
        )
      ).resolves.toBe(true);
      await expect(
        repo.reserveEvent(anEvent(hex('c', 64), 2), ctx)
      ).resolves.toBe(true);
    });

    it('releases only events that were not attached to a drop', async () => {
      await repo.reserveEvent(anEvent(hex('a', 64), 1), ctx);
      await repo.reserveEvent(anEvent(hex('b', 64), 2), ctx);
      await repo.attachEventToDrop(
        { eventId: hex('b', 64), dropId: 'drop-1' },
        ctx
      );

      await repo.deleteReservedEvent(hex('a', 64), ctx);
      await repo.deleteReservedEvent(hex('b', 64), ctx);

      await expect(
        repo.reserveEvent(anEvent(hex('a', 64), 1), ctx)
      ).resolves.toBe(true);
      const events = await repo.findEventsByDropId('drop-1', ctx);
      expect(events.map((it) => it.id)).toEqual([hex('b', 64)]);
      expect(events[0].body).toBe('{"a":"é😀"}');
    });

    it('returns attached events oldest first', async () => {
      await repo.reserveEvent(anEvent(hex('b', 64), 20), ctx);
      await repo.reserveEvent(anEvent(hex('a', 64), 10), ctx);
      await repo.attachEventToDrop({ eventId: hex('a', 64), dropId: 'd' }, ctx);
      await repo.attachEventToDrop({ eventId: hex('b', 64), dropId: 'd' }, ctx);

      const events = await repo.findEventsByDropId('d', ctx);
      expect(events.map((it) => Number(it.seq))).toEqual([10, 20]);
    });

    it('upserts and clears the author signature of a drop', async () => {
      await expect(
        repo.findDropAuthorSignatureEventId('drop-1', ctx)
      ).resolves.toBeNull();
      await repo.upsertDropAuthorSignature(
        { dropId: 'drop-1', eventId: hex('a', 64), signedAt: 1 },
        ctx
      );
      await repo.upsertDropAuthorSignature(
        { dropId: 'drop-1', eventId: hex('b', 64), signedAt: 2 },
        ctx
      );
      await expect(
        repo.findDropAuthorSignatureEventId('drop-1', ctx)
      ).resolves.toBe(hex('b', 64));

      await repo.deleteDropAuthorSignature('drop-1', ctx);
      await expect(
        repo.findDropAuthorSignatureEventId('drop-1', ctx)
      ).resolves.toBeNull();
    });
  }
);
