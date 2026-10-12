import { createPrivateKey, sign } from 'node:crypto';
import { ethers } from 'ethers';
import { mock } from 'ts-jest-mocker';
import { AuthenticationContext } from '@/auth-context';
import { DropsDb } from '@/drops/drops.db';
import { DeviceGrantEntity } from '@/entities/IDeviceGrant';
import { NotFoundException } from '@/exceptions';
import { IdentitiesDb } from '@/identities/identities.db';
import { ProfileProxyActionType } from '@/entities/IProfileProxyAction';
import {
  computeDeviceEventId,
  DeviceEventKind,
  ZERO_BODY_HASH
} from './device-event';
import { DeviceSigningDb } from './device-signing.db';
import {
  DeviceSignedWritesService,
  InvalidDeviceSignatureException,
  stripDeviceSignature
} from './device-signed-writes.service';

const SEED_HEX =
  '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
const DEVICE_KEY =
  '0xd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
const GRANT_ID =
  '0xe0b23044ded5e97599cd0d3f4ae0234df6aa13c90c633a9f12d9f597ea7f20bc';
const WALLET = '0x1111111111111111111111111111111111111111';
const WAVE_ID = '4a1e0e2c-7a7d-4b38-9c0b-2f1d6d1c9a10';
const DROP_ID = 'b0c5d6e7-1111-4222-8333-944455556666';
const PROFILE_ID = 'profile-1';
const NOW = 1760000000000;
const CLAIMED_TIME = 1760000000123;
// Contract vector: POST of VECTOR_BODY with seq 1760000000000.
const VECTOR_EVENT_ID =
  '0x85085439fde88ab7c9c2979f922c1eb9d3b7f528819e6e7c3befad77f935b02a';
const VECTOR_SIGNATURE =
  '0xf8c7552edc9013ef82b331037b34dd7ae20fa4a6aab9feea1d906c6ee1b906db03e20254917fce0832ce5768e3a676fad76cb9d47d12b5e74536aa11e9e9cf04';
const VECTOR_BODY = {
  wave_id: WAVE_ID,
  title: null,
  parts: [{ content: 'gm é😀 "q"', media: [], quoted_drop: null }],
  referenced_nfts: [],
  mentioned_users: [],
  metadata: [],
  reply_to: { drop_id: DROP_ID, drop_part_id: 1 },
  signature: null,
  is_safe_signature: false,
  signer_address: WALLET,
  drop_type: 'CHAT',
  hide_link_preview: false
};

const privateKey = createPrivateKey({
  key: Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    Buffer.from(SEED_HEX, 'hex')
  ]),
  format: 'der',
  type: 'pkcs8'
});

function signEventId(eventId: string): string {
  return `0x${sign(null, Buffer.from(eventId.slice(2), 'hex'), privateKey).toString('hex')}`;
}

function aGrant(overrides: Partial<DeviceGrantEntity> = {}): DeviceGrantEntity {
  return {
    id: GRANT_ID,
    wallet: WALLET,
    key_type: 'ed25519',
    device_key: DEVICE_KEY,
    scopes: 'post,edit,delete,react',
    device_label: 'Browser',
    domain: '6529.io',
    message: 'message',
    wallet_signature: '0xsig',
    chain_id: 1,
    issued_at: NOW - 1000,
    expires_at: NOW + 86_400_000,
    created_at: NOW - 1000,
    revoked_at: null,
    last_used_at: null,
    ...overrides
  };
}

function anAuthenticationContext(
  overrides: Partial<{
    authenticatedProfileId: string | null;
    roleProfileId: string | null;
  }> = {}
): AuthenticationContext {
  return new AuthenticationContext({
    authenticatedWallet: WALLET,
    authenticatedProfileId: PROFILE_ID,
    roleProfileId: null,
    activeProxyActions: [],
    ...overrides
  });
}

function signedEnvelope({
  kind,
  seq,
  refs,
  bodyHash,
  bodySize,
  claimedTime = CLAIMED_TIME
}: {
  kind: DeviceEventKind;
  seq: number;
  refs: string[];
  bodyHash: string;
  bodySize: number;
  claimedTime?: number;
}) {
  const eventId = computeDeviceEventId({
    kind,
    kindVersion: 1,
    wave: WAVE_ID,
    author: WALLET,
    keyType: 2,
    deviceKey: DEVICE_KEY,
    authRef: GRANT_ID,
    seq,
    anchor: 0,
    claimedTime,
    refs,
    bodyHash,
    bodySize
  });
  return {
    eventId,
    envelope: {
      grant_id: GRANT_ID,
      seq,
      claimed_time: claimedTime,
      signature: signEventId(eventId)
    }
  };
}

const VECTOR_ENVELOPE = {
  grant_id: GRANT_ID,
  seq: 1760000000000,
  claimed_time: CLAIMED_TIME,
  signature: VECTOR_SIGNATURE
};

describe('stripDeviceSignature', () => {
  it('removes device_signature and returns it separately', () => {
    const body = { a: 1, device_signature: { grant_id: 'x' } };
    expect(stripDeviceSignature(body)).toEqual({
      body: { a: 1 },
      envelope: { grant_id: 'x' }
    });
    expect(body).toHaveProperty('device_signature');
  });

  it('leaves bodies without device_signature untouched', () => {
    const body = { a: 1 };
    const stripped = stripDeviceSignature(body);
    expect(stripped.body).toBe(body);
    expect(stripped.envelope).toBeUndefined();
  });

  it('keeps an explicit null as a present envelope', () => {
    expect(stripDeviceSignature({ device_signature: null })).toEqual({
      body: {},
      envelope: null
    });
  });

  it.each([undefined, null, 'text', [1]])(
    'passes through non-object body %j',
    (body) => {
      expect(stripDeviceSignature(body)).toEqual({
        body,
        envelope: undefined
      });
    }
  );
});

describe('DeviceSignedWritesService', () => {
  let db: DeviceSigningDb;
  let identities: IdentitiesDb;
  let drops: DropsDb;
  let service: DeviceSignedWritesService;
  const connection = { connection: 'tx' };
  const ctx = () => ({ authenticationContext: anAuthenticationContext() });

  beforeEach(() => {
    db = mock(DeviceSigningDb);
    identities = mock(IdentitiesDb);
    drops = mock(DropsDb);
    service = new DeviceSignedWritesService(db, identities, drops, () => NOW);
    jest.mocked(db.findGrantById).mockResolvedValue(aGrant());
    jest.mocked(db.reserveEvent).mockResolvedValue(true);
    jest.mocked(db.deleteReservedEvent).mockResolvedValue(undefined);
    jest.mocked(db.attachEventToDrop).mockResolvedValue(undefined);
    jest.mocked(db.upsertDropAuthorSignature).mockResolvedValue(undefined);
    jest.mocked(db.deleteDropAuthorSignature).mockResolvedValue(undefined);
    jest.mocked(db.touchGrantLastUsed).mockResolvedValue(undefined);
    jest
      .mocked(db.executeNativeQueriesInTransaction)
      .mockImplementation(async (fn) => fn(connection));
    jest.mocked(identities.getProfileIdByWallet).mockResolvedValue(PROFILE_ID);
    jest.mocked(drops.findWaveIdByDropId).mockResolvedValue(WAVE_ID);
  });

  function createVectorDrop(
    envelope: unknown = VECTOR_ENVELOPE,
    write = jest.fn().mockResolvedValue({ id: 'new-drop' }),
    context = ctx(),
    body: unknown = JSON.parse(JSON.stringify(VECTOR_BODY))
  ) {
    return service.createDrop(
      { envelope, waveId: WAVE_ID, replyToDropId: DROP_ID, body },
      write,
      context
    );
  }

  async function expectInvalid(
    promise: Promise<unknown>,
    reason: string | RegExp
  ): Promise<InvalidDeviceSignatureException> {
    const error = await promise.then(
      () => {
        throw new Error('expected rejection');
      },
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(InvalidDeviceSignatureException);
    const invalid = error as InvalidDeviceSignatureException;
    expect(invalid.getStatusCode()).toBe(400);
    expect(invalid.code).toBe('INVALID_DEVICE_SIGNATURE');
    expect(invalid.message.startsWith('Invalid device signature: ')).toBe(true);
    expect(invalid.message).toMatch(reason);
    return invalid;
  }

  describe('signed POST', () => {
    it('verifies the contract vector, reserves, writes and finalizes', async () => {
      const write = jest.fn().mockResolvedValue({ id: 'new-drop' });

      await expect(createVectorDrop(VECTOR_ENVELOPE, write)).resolves.toEqual({
        id: 'new-drop'
      });

      expect(db.reserveEvent).toHaveBeenCalledWith(
        {
          id: VECTOR_EVENT_ID,
          kind: 1,
          kind_version: 1,
          wave_id: WAVE_ID,
          drop_id: null,
          author: WALLET,
          profile_id: PROFILE_ID,
          key_type: 2,
          device_key: DEVICE_KEY,
          grant_id: GRANT_ID,
          seq: 1760000000000,
          anchor: 0,
          claimed_time: CLAIMED_TIME,
          refs: JSON.stringify([DROP_ID]),
          body: expect.stringContaining('"drop_type":"CHAT"'),
          body_hash:
            '0x21f35f2f1bfccadb13cb9ad660c3f7c38d971327557f4bf921b37511d808fcf5',
          body_size: 418,
          signature: VECTOR_SIGNATURE,
          created_at: NOW
        },
        expect.anything()
      );
      expect(
        jest.mocked(db.reserveEvent).mock.invocationCallOrder[0]
      ).toBeLessThan(write.mock.invocationCallOrder[0]);
      const txCtx = { timer: undefined, connection };
      expect(db.attachEventToDrop).toHaveBeenCalledWith(
        { eventId: VECTOR_EVENT_ID, dropId: 'new-drop' },
        txCtx
      );
      expect(db.upsertDropAuthorSignature).toHaveBeenCalledWith(
        { dropId: 'new-drop', eventId: VECTOR_EVENT_ID, signedAt: NOW },
        txCtx
      );
      expect(db.touchGrantLastUsed).toHaveBeenCalledWith(GRANT_ID, NOW, txCtx);
      expect(db.deleteReservedEvent).not.toHaveBeenCalled();
    });

    it('signs an empty refs list when there is no reply target', async () => {
      const body = { wave_id: WAVE_ID, parts: [] };
      const canonical = '{"parts":[],"wave_id":"' + WAVE_ID + '"}';
      const { envelope } = signedEnvelope({
        kind: DeviceEventKind.POST,
        seq: 5,
        refs: [],
        bodyHash: ethers.keccak256(ethers.toUtf8Bytes(canonical)),
        bodySize: Buffer.byteLength(canonical)
      });
      await expect(
        service.createDrop(
          { envelope, waveId: WAVE_ID, replyToDropId: null, body },
          jest.fn().mockResolvedValue({ id: 'd' }),
          ctx()
        )
      ).resolves.toEqual({ id: 'd' });
      expect(db.reserveEvent).toHaveBeenCalledWith(
        expect.objectContaining({ refs: '[]', body: canonical }),
        expect.anything()
      );
    });

    it('releases the reservation and rethrows when the write fails', async () => {
      const failure = new Error('write failed');

      await expect(
        createVectorDrop(VECTOR_ENVELOPE, jest.fn().mockRejectedValue(failure))
      ).rejects.toBe(failure);

      expect(db.deleteReservedEvent).toHaveBeenCalledWith(VECTOR_EVENT_ID, {
        timer: undefined
      });
      expect(db.attachEventToDrop).not.toHaveBeenCalled();
      expect(db.touchGrantLastUsed).not.toHaveBeenCalled();
    });

    it('keeps the successful write when finalizing fails', async () => {
      jest
        .mocked(db.executeNativeQueriesInTransaction)
        .mockRejectedValue(new Error('db down'));

      await expect(createVectorDrop()).resolves.toEqual({ id: 'new-drop' });
      expect(db.deleteReservedEvent).not.toHaveBeenCalled();
    });

    it('passes unsigned creates straight through', async () => {
      const write = jest.fn().mockResolvedValue({ id: 'unsigned' });

      await expect(
        service.createDrop(
          {
            envelope: undefined,
            waveId: WAVE_ID,
            replyToDropId: DROP_ID,
            body: VECTOR_BODY
          },
          write,
          ctx()
        )
      ).resolves.toEqual({ id: 'unsigned' });

      expect(db.findGrantById).not.toHaveBeenCalled();
      expect(db.reserveEvent).not.toHaveBeenCalled();
      expect(db.executeNativeQueriesInTransaction).not.toHaveBeenCalled();
      expect(db.deleteDropAuthorSignature).not.toHaveBeenCalled();
    });
  });

  describe('rejections', () => {
    it.each([
      ['null', null],
      ['missing seq', { ...VECTOR_ENVELOPE, seq: undefined }],
      ['string seq', { ...VECTOR_ENVELOPE, seq: '1760000000000' }],
      ['zero seq', { ...VECTOR_ENVELOPE, seq: 0 }],
      ['fractional seq', { ...VECTOR_ENVELOPE, seq: 1.5 }],
      ['unsafe seq', { ...VECTOR_ENVELOPE, seq: 2 ** 53 }],
      ['negative claimed_time', { ...VECTOR_ENVELOPE, claimed_time: -1 }],
      [
        'uppercase grant id',
        { ...VECTOR_ENVELOPE, grant_id: GRANT_ID.toUpperCase() }
      ],
      [
        'short signature',
        { ...VECTOR_ENVELOPE, signature: VECTOR_SIGNATURE.slice(0, -2) }
      ],
      ['extra member', { ...VECTOR_ENVELOPE, extra: true }]
    ])('rejects a malformed envelope: %s', async (_name, envelope) => {
      await expectInvalid(createVectorDrop(envelope), /malformed envelope/);
      expect(db.findGrantById).not.toHaveBeenCalled();
    });

    it('rejects callers acting as a proxy', async () => {
      const proxyContext = {
        authenticationContext: new AuthenticationContext({
          authenticatedWallet: WALLET,
          authenticatedProfileId: PROFILE_ID,
          roleProfileId: 'principal',
          activeProxyActions: [
            {
              id: 'a',
              type: ProfileProxyActionType.CREATE_DROP_TO_WAVE,
              credit_amount: null,
              credit_spent: null
            }
          ]
        })
      };
      await expectInvalid(
        createVectorDrop(VECTOR_ENVELOPE, undefined, proxyContext),
        /proxy/
      );
      expect(db.findGrantById).not.toHaveBeenCalled();
    });

    it.each([
      ['unknown grant', null, /unknown grant/],
      ['revoked grant', aGrant({ revoked_at: NOW - 1 }), /revoked/],
      ['expired grant', aGrant({ expires_at: NOW }), /expired/],
      ['grant without the post scope', aGrant({ scopes: 'edit' }), /post scope/]
    ])('rejects an %s', async (_name, grant, reason) => {
      jest.mocked(db.findGrantById).mockResolvedValue(grant);
      await expectInvalid(createVectorDrop(), reason);
      expect(db.reserveEvent).not.toHaveBeenCalled();
    });

    it('rejects a grant whose wallet is not the acting profile', async () => {
      jest.mocked(identities.getProfileIdByWallet).mockResolvedValue('other');
      await expectInvalid(createVectorDrop(), /acting profile/);
      expect(identities.getProfileIdByWallet).toHaveBeenCalledWith(WALLET);
    });

    it('rejects callers without a profile', async () => {
      await expectInvalid(
        createVectorDrop(VECTOR_ENVELOPE, undefined, {
          authenticationContext: anAuthenticationContext({
            authenticatedProfileId: null
          })
        }),
        /acting profile/
      );
    });

    it.each([
      ['too far in the past', NOW - 600_001],
      ['too far in the future', NOW + 600_001]
    ])('rejects a claimed_time %s', async (_name, claimedTime) => {
      const { envelope } = signedEnvelope({
        kind: DeviceEventKind.POST,
        seq: 9,
        refs: [DROP_ID],
        bodyHash: ZERO_BODY_HASH,
        bodySize: 0,
        claimedTime
      });
      await expectInvalid(createVectorDrop(envelope), /10 minutes/);
    });

    it('accepts a claimed_time exactly 10 minutes away', async () => {
      const service10 = new DeviceSignedWritesService(
        db,
        identities,
        drops,
        () => CLAIMED_TIME + 600_000
      );
      await expect(
        service10.createDrop(
          {
            envelope: VECTOR_ENVELOPE,
            waveId: WAVE_ID,
            replyToDropId: DROP_ID,
            body: JSON.parse(JSON.stringify(VECTOR_BODY))
          },
          jest.fn().mockResolvedValue({ id: 'x' }),
          ctx()
        )
      ).resolves.toEqual({ id: 'x' });
    });

    it.each([
      [
        'a changed body',
        { ...VECTOR_BODY, title: 'changed' },
        WAVE_ID,
        DROP_ID
      ],
      ['another wave', VECTOR_BODY, 'other-wave', DROP_ID],
      ['another reply target', VECTOR_BODY, WAVE_ID, 'other-drop']
    ])(
      'rejects a signature over %s',
      async (_name, body, waveId, replyToDropId) => {
        await expectInvalid(
          service.createDrop(
            {
              envelope: VECTOR_ENVELOPE,
              waveId,
              replyToDropId,
              body: JSON.parse(JSON.stringify(body))
            },
            jest.fn(),
            ctx()
          ),
          /does not verify/
        );
        expect(db.reserveEvent).not.toHaveBeenCalled();
      }
    );

    it('rejects a grant with another key', async () => {
      jest
        .mocked(db.findGrantById)
        .mockResolvedValue(aGrant({ device_key: `0x${'ab'.repeat(32)}` }));
      await expectInvalid(createVectorDrop(), /does not verify/);
    });

    it('rejects a body that cannot be canonicalized', async () => {
      await expectInvalid(
        createVectorDrop(VECTOR_ENVELOPE, undefined, ctx(), {
          n: Infinity
        }),
        /canonicalized/
      );
    });

    it('rejects a replayed event or reused sequence number', async () => {
      jest.mocked(db.reserveEvent).mockResolvedValue(false);
      const write = jest.fn();
      await expectInvalid(
        createVectorDrop(VECTOR_ENVELOPE, write),
        /already used/
      );
      expect(write).not.toHaveBeenCalled();
      expect(db.deleteReservedEvent).not.toHaveBeenCalled();
    });
  });

  describe('signed mutations of an existing drop', () => {
    it('signs a TOMBSTONE over the stored wave with no body (contract vector)', async () => {
      const { envelope, eventId } = signedEnvelope({
        kind: DeviceEventKind.TOMBSTONE,
        seq: 1760000000001,
        refs: [DROP_ID],
        bodyHash: ZERO_BODY_HASH,
        bodySize: 0
      });
      expect(eventId).toBe(
        '0x13ad6341cb212fcaee1b119a7fd2b65eba48e74310b1725dabc4697ec99355be'
      );
      const write = jest.fn().mockResolvedValue(undefined);

      await service.mutateDrop(
        {
          envelope,
          kind: DeviceEventKind.TOMBSTONE,
          dropId: DROP_ID,
          body: null
        },
        write,
        ctx()
      );

      expect(drops.findWaveIdByDropId).toHaveBeenCalledWith(
        DROP_ID,
        expect.anything()
      );
      expect(db.reserveEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          id: eventId,
          kind: 3,
          body: null,
          body_hash: ZERO_BODY_HASH,
          body_size: 0
        }),
        expect.anything()
      );
      expect(write).toHaveBeenCalled();
      expect(db.attachEventToDrop).toHaveBeenCalledWith(
        { eventId, dropId: DROP_ID },
        expect.anything()
      );
      expect(db.deleteDropAuthorSignature).toHaveBeenCalledWith(
        DROP_ID,
        expect.anything()
      );
      expect(db.upsertDropAuthorSignature).not.toHaveBeenCalled();
    });

    it('signs an EDIT with the given stored wave and upserts the author signature', async () => {
      const body = { parts: [] };
      const canonical = '{"parts":[]}';
      const { envelope, eventId } = signedEnvelope({
        kind: DeviceEventKind.EDIT,
        seq: 10,
        refs: [DROP_ID],
        bodyHash: ethers.keccak256(ethers.toUtf8Bytes(canonical)),
        bodySize: canonical.length
      });

      await service.mutateDrop(
        {
          envelope,
          kind: DeviceEventKind.EDIT,
          dropId: DROP_ID,
          waveId: WAVE_ID,
          body
        },
        jest.fn().mockResolvedValue({ id: DROP_ID }),
        ctx()
      );

      expect(drops.findWaveIdByDropId).not.toHaveBeenCalled();
      expect(db.upsertDropAuthorSignature).toHaveBeenCalledWith(
        { dropId: DROP_ID, eventId, signedAt: NOW },
        expect.anything()
      );
    });

    it('signs a REACT without touching the author signature', async () => {
      const canonical = '{"on":true,"reaction":":+1:"}';
      const { envelope, eventId } = signedEnvelope({
        kind: DeviceEventKind.REACT,
        seq: 11,
        refs: [DROP_ID],
        bodyHash: ethers.keccak256(ethers.toUtf8Bytes(canonical)),
        bodySize: canonical.length
      });

      await service.mutateDrop(
        {
          envelope,
          kind: DeviceEventKind.REACT,
          dropId: DROP_ID,
          body: { on: true, reaction: ':+1:' }
        },
        jest.fn().mockResolvedValue({}),
        ctx()
      );

      expect(db.attachEventToDrop).toHaveBeenCalledWith(
        { eventId, dropId: DROP_ID },
        expect.anything()
      );
      expect(db.upsertDropAuthorSignature).not.toHaveBeenCalled();
      expect(db.deleteDropAuthorSignature).not.toHaveBeenCalled();
      expect(db.touchGrantLastUsed).toHaveBeenCalled();
    });

    it('rejects a REACT signed as a POST', async () => {
      await expectInvalid(
        service.mutateDrop(
          {
            envelope: VECTOR_ENVELOPE,
            kind: DeviceEventKind.REACT,
            dropId: DROP_ID,
            body: JSON.parse(JSON.stringify(VECTOR_BODY))
          },
          jest.fn(),
          ctx()
        ),
        /does not verify/
      );
    });

    it.each([DeviceEventKind.EDIT, DeviceEventKind.REACT] as const)(
      'returns 404 for a missing drop (kind %s)',
      async (kind) => {
        jest.mocked(drops.findWaveIdByDropId).mockResolvedValue(null);
        const write = jest.fn();
        await expect(
          service.mutateDrop(
            { envelope: VECTOR_ENVELOPE, kind, dropId: DROP_ID, body: {} },
            write,
            ctx()
          )
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(write).not.toHaveBeenCalled();
      }
    );

    it('keeps deleting a missing drop a no-op without storing an event', async () => {
      jest.mocked(drops.findWaveIdByDropId).mockResolvedValue(null);
      const write = jest.fn().mockResolvedValue(undefined);
      await service.mutateDrop(
        {
          envelope: VECTOR_ENVELOPE,
          kind: DeviceEventKind.TOMBSTONE,
          dropId: DROP_ID,
          body: null
        },
        write,
        ctx()
      );
      expect(write).toHaveBeenCalled();
      expect(db.reserveEvent).not.toHaveBeenCalled();
    });
  });

  describe('unsigned mutations', () => {
    it('clears the author signature before and after an unsigned EDIT', async () => {
      const write = jest.fn().mockResolvedValue({ id: DROP_ID });
      await service.mutateDrop(
        {
          envelope: undefined,
          kind: DeviceEventKind.EDIT,
          dropId: DROP_ID,
          waveId: WAVE_ID,
          body: {}
        },
        write,
        ctx()
      );
      const clearOrder = jest.mocked(db.deleteDropAuthorSignature).mock
        .invocationCallOrder;
      expect(clearOrder).toHaveLength(2);
      expect(clearOrder[0]).toBeLessThan(write.mock.invocationCallOrder[0]);
      expect(clearOrder[1]).toBeGreaterThan(write.mock.invocationCallOrder[0]);
      expect(db.findGrantById).not.toHaveBeenCalled();
    });

    it('clears the author signature after an unsigned delete', async () => {
      await service.mutateDrop(
        {
          envelope: undefined,
          kind: DeviceEventKind.TOMBSTONE,
          dropId: DROP_ID,
          body: null
        },
        jest.fn().mockResolvedValue(undefined),
        ctx()
      );
      expect(db.deleteDropAuthorSignature).toHaveBeenCalledTimes(1);
    });

    it('does not fail an unsigned write when clearing fails', async () => {
      jest
        .mocked(db.deleteDropAuthorSignature)
        .mockRejectedValue(new Error('table missing'));
      await expect(
        service.mutateDrop(
          {
            envelope: undefined,
            kind: DeviceEventKind.EDIT,
            dropId: DROP_ID,
            body: {}
          },
          jest.fn().mockResolvedValue('edited'),
          ctx()
        )
      ).resolves.toBe('edited');
    });

    it('does not touch device tables for unsigned reactions', async () => {
      await service.mutateDrop(
        {
          envelope: undefined,
          kind: DeviceEventKind.REACT,
          dropId: DROP_ID,
          body: { on: false }
        },
        jest.fn().mockResolvedValue('drop'),
        ctx()
      );
      expect(db.deleteDropAuthorSignature).not.toHaveBeenCalled();
      expect(drops.findWaveIdByDropId).not.toHaveBeenCalled();
    });

    it('does not run the write twice and propagates its error', async () => {
      const failure = new Error('forbidden');
      const write = jest.fn().mockRejectedValue(failure);
      await expect(
        service.mutateDrop(
          {
            envelope: undefined,
            kind: DeviceEventKind.TOMBSTONE,
            dropId: DROP_ID,
            body: null
          },
          write,
          ctx()
        )
      ).rejects.toBe(failure);
      expect(write).toHaveBeenCalledTimes(1);
      expect(db.deleteDropAuthorSignature).not.toHaveBeenCalled();
    });
  });
});
