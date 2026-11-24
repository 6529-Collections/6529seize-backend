import { AuthenticationContext } from '@/auth-context';
import { DropType } from '@/entities/IDrop';
import { DeviceEventKind } from './device-event';
import {
  DEVICE_SIGNATURE_REQUIRED_CODE,
  DEVICE_SIGNATURE_REQUIRED_PROXY_MESSAGE,
  DeviceSignatureRequiredException,
  DeviceSignedWritesService
} from './device-signed-writes.service';

const FLAG = 'FEATURE_WAVES_DEVICE_SIGNATURE_REQUIRED';

function service(
  waves: Record<string, { is_direct_message: boolean }>,
  drops: Record<string, { wave_id: string; drop_type: DropType }> = {},
  // Waves that stay on 6529.io (wave-relay-scope.ts).
  staying: string[] = []
) {
  const dropsDb = {
    findDropById: jest.fn(async (dropId: string) => drops[dropId] ?? null),
    findWaveByIdOrNull: jest.fn(async (waveId: string) =>
      waves[waveId] ? { id: waveId, ...waves[waveId] } : null
    ),
    findWaveIdByDropId: jest.fn()
  };
  const waveScope = {
    staysOnSite: jest.fn(async (waveId: string) => staying.includes(waveId))
  };
  const db = {
    deleteDropAuthorSignature: jest.fn(),
    executeNativeQueriesInTransaction: jest.fn(async (work: any) =>
      work({ writer: true })
    )
  };
  return {
    service: new DeviceSignedWritesService(
      db as any,
      {} as any,
      dropsDb as any,
      () => Date.now(),
      waveScope
    ),
    dropsDb,
    db,
    waveScope
  };
}

function ctx(proxy = false) {
  return {
    authenticationContext: new AuthenticationContext({
      authenticatedWallet: '0x1111111111111111111111111111111111111111',
      authenticatedProfileId: proxy ? 'proxy' : 'author',
      roleProfileId: proxy ? 'author' : null,
      activeProxyActions: []
    })
  };
}

describe('device signatures required from switch-on', () => {
  const original = process.env[FLAG];
  afterEach(() => {
    if (original === undefined) delete process.env[FLAG];
    else process.env[FLAG] = original;
  });

  const write = jest.fn(async () => ({ id: 'drop-1' }));
  beforeEach(() => write.mockClear());

  const chatDrops = {
    d: { wave_id: 'w', drop_type: DropType.CHAT },
    dm: { wave_id: 'dm-wave', drop_type: DropType.CHAT },
    entry: { wave_id: 'w', drop_type: DropType.PARTICIPATORY }
  };

  it('writes unsigned drops as before when not required', async () => {
    delete process.env[FLAG];
    const { service: s, dropsDb, db } = service({});
    await expect(
      s.createDrop(
        { envelope: undefined, waveId: 'w', replyToDropId: null, body: {} },
        write,
        ctx()
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
      ctx()
    );
    await s.assertUnsignedChatRatingAllowed('d', ctx());
    expect(dropsDb.findDropById).not.toHaveBeenCalled();
    expect(dropsDb.findWaveByIdOrNull).not.toHaveBeenCalled();
    expect(db.executeNativeQueriesInTransaction).not.toHaveBeenCalled();
  });

  it('refuses unsigned posts, edits, deletes and reactions in waves', async () => {
    process.env[FLAG] = 'true';
    const { service: s, dropsDb } = service(
      { w: { is_direct_message: false } },
      chatDrops
    );
    await expect(
      s.createDrop(
        { envelope: undefined, waveId: 'w', replyToDropId: null, body: {} },
        write,
        ctx()
      )
    ).rejects.toBeInstanceOf(DeviceSignatureRequiredException);
    for (const kind of [
      DeviceEventKind.EDIT,
      DeviceEventKind.TOMBSTONE,
      DeviceEventKind.REACT
    ] as const) {
      await expect(
        s.mutateDrop(
          { envelope: undefined, kind, dropId: 'd', body: {} },
          write,
          ctx()
        )
      ).rejects.toMatchObject({ code: DEVICE_SIGNATURE_REQUIRED_CODE });
    }
    expect(write).not.toHaveBeenCalled();
    // Read on the writer, so a drop made a moment ago counts.
    expect(dropsDb.findDropById).toHaveBeenCalledWith('d', { writer: true });
    expect(new DeviceSignatureRequiredException().getStatusCode()).toBe(403);
  });

  it('tells a proxy it cannot post for the author', async () => {
    process.env[FLAG] = 'true';
    const { service: s } = service({ w: { is_direct_message: false } });
    await expect(
      s.createDrop(
        { envelope: undefined, waveId: 'w', replyToDropId: null, body: {} },
        write,
        ctx(true)
      )
    ).rejects.toThrow(DEVICE_SIGNATURE_REQUIRED_PROXY_MESSAGE);
  });

  it('keeps direct messages, and missing drops and waves, as they are', async () => {
    process.env[FLAG] = 'true';
    const { service: s } = service(
      { 'dm-wave': { is_direct_message: true } },
      chatDrops
    );
    await expect(
      s.createDrop(
        {
          envelope: undefined,
          waveId: 'dm-wave',
          replyToDropId: null,
          body: {}
        },
        write,
        ctx()
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
        ctx()
      )
    ).resolves.toEqual({ id: 'drop-1' });
    // A wave that doesn't exist: the write answers not found itself.
    await expect(
      s.createDrop(
        {
          envelope: undefined,
          waveId: 'nowhere',
          replyToDropId: null,
          body: {}
        },
        write,
        ctx()
      )
    ).resolves.toEqual({ id: 'drop-1' });
  });

  it('refuses a +1 or -1 on a chat drop in a wave, not on an entry or a DM', async () => {
    process.env[FLAG] = 'true';
    const { service: s } = service(
      {
        w: { is_direct_message: false },
        'dm-wave': { is_direct_message: true }
      },
      chatDrops
    );
    await expect(
      s.assertUnsignedChatRatingAllowed('d', ctx())
    ).rejects.toBeInstanceOf(DeviceSignatureRequiredException);
    await expect(
      s.assertUnsignedChatRatingAllowed('entry', ctx())
    ).resolves.toBeUndefined();
    await expect(
      s.assertUnsignedChatRatingAllowed('dm', ctx())
    ).resolves.toBeUndefined();
    await expect(
      s.assertUnsignedChatRatingAllowed('missing', ctx())
    ).resolves.toBeUndefined();
  });

  it('keeps every wave that stays on 6529.io open, as today: posts, edits, deletes, reactions and chat ratings', async () => {
    process.env[FLAG] = 'true';
    const { service: s, waveScope } = service(
      {
        w: { is_direct_message: false },
        'site-wave': { is_direct_message: false }
      },
      {
        d: { wave_id: 'w', drop_type: DropType.CHAT },
        s: { wave_id: 'site-wave', drop_type: DropType.CHAT }
      },
      ['site-wave']
    );
    await expect(
      s.createDrop(
        {
          envelope: undefined,
          waveId: 'site-wave',
          replyToDropId: null,
          body: {}
        },
        write,
        ctx(true)
      )
    ).resolves.toEqual({ id: 'drop-1' });
    for (const kind of [
      DeviceEventKind.EDIT,
      DeviceEventKind.TOMBSTONE,
      DeviceEventKind.REACT
    ] as const) {
      await expect(
        s.mutateDrop(
          { envelope: undefined, kind, dropId: 's', body: {} },
          write,
          ctx()
        )
      ).resolves.toEqual({ id: 'drop-1' });
    }
    await expect(
      s.assertUnsignedChatRatingAllowed('s', ctx())
    ).resolves.toBeUndefined();
    expect(write).toHaveBeenCalledTimes(4);
    // A wave that moves still needs the signature.
    await expect(
      s.createDrop(
        { envelope: undefined, waveId: 'w', replyToDropId: null, body: {} },
        write,
        ctx()
      )
    ).rejects.toBeInstanceOf(DeviceSignatureRequiredException);
    expect(waveScope.staysOnSite.mock.calls.map((c) => c[0])).toEqual([
      'site-wave',
      'site-wave',
      'site-wave',
      'site-wave',
      'site-wave',
      'w'
    ]);
  });

  it('asks nothing about a direct message or a missing wave', async () => {
    process.env[FLAG] = 'true';
    const { service: s, waveScope } = service(
      { 'dm-wave': { is_direct_message: true } },
      {}
    );
    await s.createDrop(
      { envelope: undefined, waveId: 'dm-wave', replyToDropId: null, body: {} },
      write,
      ctx()
    );
    await s.createDrop(
      { envelope: undefined, waveId: 'nowhere', replyToDropId: null, body: {} },
      write,
      ctx()
    );
    expect(waveScope.staysOnSite).not.toHaveBeenCalled();
  });
});
