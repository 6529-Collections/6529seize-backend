import { ethers } from 'ethers';
import {
  computeDeviceEventId,
  DEVICE_EVENT_KIND_VERSION,
  DeviceEventKind,
  verifyEd25519EventSignature
} from '@/api/device-signing/device-event';
import { canonicalizeJson } from '@/profile-cms/protocol/v1/canonical-json';
import { VECTORS } from '../record-test-fixtures';
import {
  loadServiceIdentity,
  SignedServiceDropPoster
} from './records-wave-poster';

const ENV = {
  SIGNED_RECORDS_WAVE_ID: '4a1e0e2c-7a7d-4b38-9c0b-2f1d6d1c9a10',
  SIGNED_RECORDS_SERVICE_PROFILE_ID: 'service-profile',
  SIGNED_RECORDS_SERVICE_WALLET: VECTORS.inputs.author,
  SIGNED_RECORDS_SERVICE_GRANT_ID: VECTORS.inputs.authRef,
  SIGNED_RECORDS_SERVICE_DEVICE_SEED: VECTORS.inputs.ed25519Seed
};

describe('loadServiceIdentity', () => {
  it('derives the device key from the seed', () => {
    expect(loadServiceIdentity(ENV)).toMatchObject({
      waveId: ENV.SIGNED_RECORDS_WAVE_ID,
      profileId: 'service-profile',
      wallet: VECTORS.inputs.author,
      grantId: VECTORS.inputs.authRef,
      deviceKey: VECTORS.inputs.deviceKey
    });
  });

  it('is null when unset and refuses malformed values', () => {
    expect(loadServiceIdentity({})).toBeNull();
    expect(() =>
      loadServiceIdentity({ ...ENV, SIGNED_RECORDS_SERVICE_WALLET: 'nope' })
    ).toThrow('Malformed');
  });
});

describe('SignedServiceDropPoster', () => {
  const identity = loadServiceIdentity(ENV)!;

  it('signs exactly the body it posts, as a drop event of the wave', async () => {
    const signedWrites = {
      createDrop: jest.fn(
        async (_args: unknown, write: () => Promise<{ id: string }>) => write()
      )
    };
    const dropCreation = {
      createDrop: jest.fn(async () => ({ id: 'drop-1' }))
    };
    const poster = new SignedServiceDropPoster(identity, {
      signedWrites: signedWrites as never,
      dropCreation: dropCreation as never,
      now: () => 1_795_694_700_000
    });
    await expect(
      poster.post('6529.io records\nchain: public', {})
    ).resolves.toBe('drop-1');
    const [args] = signedWrites.createDrop.mock.calls[0] as unknown as [
      {
        envelope: {
          grant_id: string;
          seq: number;
          claimed_time: number;
          signature: string;
        };
        waveId: string;
        replyToDropId: null;
        body: object;
      }
    ];
    expect(args.waveId).toBe(ENV.SIGNED_RECORDS_WAVE_ID);
    expect(args.replyToDropId).toBeNull();
    const bytes = ethers.toUtf8Bytes(canonicalizeJson(args.body));
    const eventId = computeDeviceEventId({
      kind: DeviceEventKind.POST,
      kindVersion: DEVICE_EVENT_KIND_VERSION,
      wave: ENV.SIGNED_RECORDS_WAVE_ID,
      author: identity.wallet,
      keyType: 2,
      deviceKey: identity.deviceKey,
      authRef: identity.grantId,
      seq: args.envelope.seq,
      anchor: 0,
      claimedTime: args.envelope.claimed_time,
      refs: [],
      bodyHash: ethers.keccak256(bytes),
      bodySize: bytes.length
    });
    expect(
      verifyEd25519EventSignature({
        deviceKey: identity.deviceKey,
        eventId,
        signature: args.envelope.signature
      })
    ).toBe(true);
    expect(dropCreation.createDrop).toHaveBeenCalledWith(
      expect.objectContaining({
        createDropRequest: args.body,
        authorId: 'service-profile',
        representativeId: 'service-profile'
      }),
      expect.objectContaining({
        authenticationContext: expect.objectContaining({
          authenticatedProfileId: 'service-profile',
          authenticatedWallet: identity.wallet
        })
      })
    );
  });

  it('gives a retried text the same client drop id and a rising seq', () => {
    const poster = new SignedServiceDropPoster(identity, {
      signedWrites: {} as never,
      dropCreation: {} as never,
      now: () => 5
    });
    const first = poster.buildRequest('head');
    expect(poster.buildRequest('head').client_drop_id).toBe(
      first.client_drop_id
    );
    expect(poster.buildRequest('other').client_drop_id).not.toBe(
      first.client_drop_id
    );
    expect(first.client_drop_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    const a = poster.signRequest(first);
    const b = poster.signRequest(first);
    expect(b.seq).toBeGreaterThan(a.seq);
  });
});
