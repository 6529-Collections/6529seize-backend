import { AuthenticationContext } from '@/auth-context';
import { DeviceEventKind } from './device-event';
import {
  DEVICE_SIGNATURE_REQUIRED_CODE,
  DeviceSignatureRequiredException,
  DeviceSignedWritesService
} from './device-signed-writes.service';

const FLAG = 'FEATURE_WAVES_DEVICE_SIGNATURE_REQUIRED';

function service(waves: Record<string, { is_direct_message: boolean }>) {
  const drops = {
    findWaveIdByDropId: jest.fn(async (dropId: string) =>
      dropId === 'missing' ? null : `wave-of-${dropId}`
    ),
    findWaveByIdOrNull: jest.fn(
      async (waveId: string) => waves[waveId] ?? null
    ),
    findDropById: jest.fn(async () => null)
  };
  const db = { deleteDropAuthorSignature: jest.fn() };
  return {
    service: new DeviceSignedWritesService(db as any, {} as any, drops as any),
    drops
  };
}

const ctx = {
  authenticationContext: new AuthenticationContext({
    authenticatedWallet: '0x1111111111111111111111111111111111111111',
    authenticatedProfileId: 'author',
    roleProfileId: null,
    activeProxyActions: []
  })
};

describe('device signatures required from switch-on', () => {
  const original = process.env[FLAG];
  afterEach(() => {
    if (original === undefined) delete process.env[FLAG];
    else process.env[FLAG] = original;
  });

  const write = jest.fn(async () => ({ id: 'drop-1' }));
  beforeEach(() => write.mockClear());

  it('writes unsigned drops as before when not required', async () => {
    delete process.env[FLAG];
    const { service: s, drops } = service({});
    await expect(
      s.createDrop(
        { envelope: undefined, waveId: 'w', replyToDropId: null, body: {} },
        write,
        ctx
      )
    ).resolves.toEqual({ id: 'drop-1' });
    await s.mutateDrop(
      {
        envelope: undefined,
        kind: DeviceEventKind.REACT,
        dropId: 'd',
        body: {}
      },
      write,
      ctx
    );
    expect(drops.findWaveIdByDropId).not.toHaveBeenCalled();
    expect(drops.findWaveByIdOrNull).not.toHaveBeenCalled();
  });

  it('refuses unsigned posts, edits, deletes and reactions in waves', async () => {
    process.env[FLAG] = 'true';
    const { service: s } = service({
      w: { is_direct_message: false },
      'wave-of-d': { is_direct_message: false }
    });
    const created = s.createDrop(
      { envelope: undefined, waveId: 'w', replyToDropId: null, body: {} },
      write,
      ctx
    );
    await expect(created).rejects.toBeInstanceOf(
      DeviceSignatureRequiredException
    );
    for (const kind of [
      DeviceEventKind.EDIT,
      DeviceEventKind.TOMBSTONE,
      DeviceEventKind.REACT
    ] as const) {
      await expect(
        s.mutateDrop(
          { envelope: undefined, kind, dropId: 'd', body: {} },
          write,
          ctx
        )
      ).rejects.toMatchObject({ code: DEVICE_SIGNATURE_REQUIRED_CODE });
    }
    expect(write).not.toHaveBeenCalled();
    expect(new DeviceSignatureRequiredException().getStatusCode()).toBe(403);
  });

  it('keeps direct messages and missing drops as they are', async () => {
    process.env[FLAG] = 'true';
    const { service: s } = service({ dm: { is_direct_message: true } });
    await expect(
      s.createDrop(
        { envelope: undefined, waveId: 'dm', replyToDropId: null, body: {} },
        write,
        ctx
      )
    ).resolves.toEqual({ id: 'drop-1' });
    await expect(
      s.mutateDrop(
        {
          envelope: undefined,
          kind: DeviceEventKind.TOMBSTONE,
          dropId: 'missing',
          body: null
        },
        write,
        ctx
      )
    ).resolves.toEqual({ id: 'drop-1' });
  });
});
