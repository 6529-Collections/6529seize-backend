import { E2eeRelayReads, E2eeServiceDeps } from '@/api/e2ee/e2ee-context';
import { E2eeDevicesService } from '@/api/e2ee/e2ee-devices.service';
import { E2eeGroupsService } from '@/api/e2ee/e2ee-groups.service';
import { ApiDeviceGrantProof } from '@/api/generated/models/ApiDeviceGrantProof';
import { E2eeDb } from '@/e2ee/e2ee.db';

const PROFILE = 'profile-1';
const PROOF = { id: `0x${'aa'.repeat(32)}` } as ApiDeviceGrantProof;

function serviceWith(relayReads?: E2eeRelayReads): E2eeDevicesService {
  const db = {
    getListableDevicesOfProfile: jest.fn().mockResolvedValue([]),
    getKeyPackageStatuses: jest.fn().mockResolvedValue([])
  } as unknown as E2eeDb;
  const deps = {
    db,
    now: () => 1_760_000_000_000,
    attachmentsEnabled: () => true,
    relayReads
  } as unknown as E2eeServiceDeps;
  return new E2eeDevicesService(deps);
}

const HEAD = { pos: 7, hash: `0x${'4c'.repeat(32)}` };

function reads(
  mode: string,
  grantProofs = jest.fn().mockResolvedValue([PROOF]),
  inboxHead = jest.fn().mockResolvedValue(HEAD)
) {
  return {
    settings: () => ({
      mode,
      urls: ['wss://relay.test'],
      net: '6529-interim-test',
      ordererPublicKey: `0x${'0b'.repeat(32)}`
    }),
    grantProofs,
    inboxHead
  };
}

describe('GET e2ee/me relay settings', () => {
  it('says nothing about relays while records are off or unconfigured', async () => {
    expect((await serviceWith().getMe(PROFILE)).relay).toBeUndefined();
    expect(
      (await serviceWith(reads('off')).getMe(PROFILE)).relay
    ).toBeUndefined();
    const broken = {
      settings: () => {
        throw new Error('E2EE_RELAY_URLS is empty');
      },
      grantProofs: jest.fn(),
      inboxHead: jest.fn()
    };
    expect((await serviceWith(broken).getMe(PROFILE)).relay).toBeUndefined();
  });

  it('names the relays without grant proofs in mirror mode', async () => {
    const grantProofs = jest.fn();
    const me = await serviceWith(reads('mirror', grantProofs)).getMe(PROFILE);
    expect(me.relay).toEqual({
      mode: 'mirror',
      urls: ['wss://relay.test'],
      net: '6529-interim-test',
      orderer_key: `0x${'0b'.repeat(32)}`,
      grant_proofs: []
    });
    expect(grantProofs).not.toHaveBeenCalled();
  });

  it("adds the caller's grant proofs in primary mode, for relay AUTH", async () => {
    const grantProofs = jest.fn().mockResolvedValue([PROOF]);
    const me = await serviceWith(reads('primary', grantProofs)).getMe(PROFILE);
    expect(me.relay?.grant_proofs).toEqual([PROOF]);
    expect(grantProofs).toHaveBeenCalledWith(PROFILE);
  });
});

describe('GET e2ee/devices/{k}/inbox-status relay head', () => {
  const DEVICE = `0x${'0d'.repeat(32)}`;

  function groupsWith(relayReads?: E2eeRelayReads): E2eeGroupsService {
    const db = {
      getDevice: jest.fn().mockResolvedValue({
        device_key: DEVICE,
        profile_id: PROFILE,
        revoked_at: null,
        expires_at_seconds: 2_000_000_000
      }),
      touchDevice: jest.fn().mockResolvedValue(undefined),
      getDeviceInboxState: jest
        .fn()
        .mockResolvedValue({ hasQueuedWelcomes: true, hasUnjoinedChats: false })
    } as unknown as E2eeDb;
    return new E2eeGroupsService({
      db,
      now: () => 1_760_000_000_000,
      relayReads
    } as unknown as E2eeServiceDeps);
  }

  it("names the inbox stream's head while records are on", async () => {
    for (const mode of ['mirror', 'primary']) {
      const inboxHead = jest.fn().mockResolvedValue(HEAD);
      const status = await groupsWith(
        reads(mode, undefined, inboxHead)
      ).getDeviceInboxStatus(PROFILE, DEVICE);
      expect(status).toEqual({
        has_pending_chats: true,
        has_queued_welcomes: true,
        relay_head: HEAD
      });
      expect(inboxHead).toHaveBeenCalledWith(DEVICE);
    }
  });

  it('leaves it out while records are off, unset, or the read fails', async () => {
    const without = { has_pending_chats: true, has_queued_welcomes: true };
    expect(await groupsWith().getDeviceInboxStatus(PROFILE, DEVICE)).toEqual(
      without
    );
    const off = jest.fn();
    expect(
      await groupsWith(reads('off', undefined, off)).getDeviceInboxStatus(
        PROFILE,
        DEVICE
      )
    ).toEqual(without);
    expect(off).not.toHaveBeenCalled();
    const none = jest.fn().mockResolvedValue(null);
    expect(
      await groupsWith(reads('primary', undefined, none)).getDeviceInboxStatus(
        PROFILE,
        DEVICE
      )
    ).toEqual(without);
    const failing = jest.fn().mockRejectedValue(new Error('db down'));
    expect(
      await groupsWith(
        reads('primary', undefined, failing)
      ).getDeviceInboxStatus(PROFILE, DEVICE)
    ).toEqual(without);
  });
});
