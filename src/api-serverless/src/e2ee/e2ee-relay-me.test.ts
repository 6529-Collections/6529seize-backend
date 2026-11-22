import { E2eeRelayReads, E2eeServiceDeps } from '@/api/e2ee/e2ee-context';
import { E2eeDevicesService } from '@/api/e2ee/e2ee-devices.service';
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

function reads(
  mode: string,
  grantProofs = jest.fn().mockResolvedValue([PROOF])
) {
  return {
    settings: () => ({
      mode,
      urls: ['wss://relay.test'],
      net: '6529-interim-test',
      ordererPublicKey: `0x${'0b'.repeat(32)}`
    }),
    grantProofs
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
      grantProofs: jest.fn()
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
