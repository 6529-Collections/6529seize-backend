import { AuthenticationContext } from '@/auth-context';
import { DropType } from '@/entities/IDrop';
import { DeviceEventKind } from './device-event';
import {
  DEVICE_SIGNATURE_REQUIRED_CODE,
  DEVICE_SIGNATURE_REQUIRED_PROXY_MESSAGE,
  DeviceSignatureRequiredException,
  DeviceSignedWritesService,
  isDeviceSignatureRequired
} from './device-signed-writes.service';

const FLAG = 'FEATURE_WAVES_DEVICE_SIGNATURE_REQUIRED';
const SWITCH_ON_AT = 'WAVES_SWITCH_ON_AT';
const ON_CHAIN = 'FEATURE_WAVES_ON_CHAIN';
const SWITCH_ON = '2026-11-28T00:00:00Z';
const SWITCH_ON_MS = Date.UTC(2026, 10, 28);
/** The services' clock: a minute after the switch-on unless a test moves it. */
const clock = { now: SWITCH_ON_MS + 60_000 };

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
      () => clock.now,
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
  const original = Object.fromEntries(
    [FLAG, SWITCH_ON_AT, ON_CHAIN].map((name) => [name, process.env[name]])
  );
  beforeEach(() => {
    // Switched on a minute ago, by the time; tests move either.
    process.env[SWITCH_ON_AT] = SWITCH_ON;
    delete process.env[ON_CHAIN];
    clock.now = SWITCH_ON_MS + 60_000;
  });
  afterEach(() => {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
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

describe('device signatures required: only from the switch-on', () => {
  const original = Object.fromEntries(
    [FLAG, SWITCH_ON_AT, ON_CHAIN].map((name) => [name, process.env[name]])
  );
  beforeEach(() => {
    process.env[FLAG] = 'true';
    process.env[SWITCH_ON_AT] = SWITCH_ON;
    delete process.env[ON_CHAIN];
  });
  afterEach(() => {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const write = jest.fn(async () => ({ id: 'drop-1' }));
  const waves = {
    w: { is_direct_message: false },
    'site-wave': { is_direct_message: false },
    'dm-wave': { is_direct_message: true }
  };
  const drops = {
    d: { wave_id: 'w', drop_type: DropType.CHAT },
    s: { wave_id: 'site-wave', drop_type: DropType.CHAT },
    dm: { wave_id: 'dm-wave', drop_type: DropType.CHAT }
  };
  const post = (s: DeviceSignedWritesService, waveId: string) =>
    s.createDrop(
      { envelope: undefined, waveId, replyToDropId: null, body: {} },
      write,
      ctx()
    );
  const mutate = (
    s: DeviceSignedWritesService,
    kind:
      | DeviceEventKind.EDIT
      | DeviceEventKind.TOMBSTONE
      | DeviceEventKind.REACT,
    dropId: string
  ) =>
    s.mutateDrop({ envelope: undefined, kind, dropId, body: {} }, write, ctx());
  const KINDS = [
    DeviceEventKind.EDIT,
    DeviceEventKind.TOMBSTONE,
    DeviceEventKind.REACT
  ] as const;

  it('takes unsigned posts, edits, deletes, reactions and chat ratings with the flag on before the switch-on', async () => {
    clock.now = SWITCH_ON_MS - 1;
    const {
      service: s,
      waveScope,
      dropsDb
    } = service(waves, drops, ['site-wave']);
    await expect(post(s, 'w')).resolves.toEqual({ id: 'drop-1' });
    for (const kind of KINDS) {
      await expect(mutate(s, kind, 'd')).resolves.toEqual({ id: 'drop-1' });
    }
    await expect(
      s.assertUnsignedChatRatingAllowed('d', ctx())
    ).resolves.toBeUndefined();
    // Nothing is even looked up before the switch-on.
    expect(waveScope.staysOnSite).not.toHaveBeenCalled();
    expect(dropsDb.findWaveByIdOrNull).not.toHaveBeenCalled();
  });

  it('starts refusing at the switch-on time in a process that started before it', async () => {
    clock.now = SWITCH_ON_MS - 60_000;
    const { service: s } = service(waves, drops, ['site-wave']);
    await expect(post(s, 'w')).resolves.toEqual({ id: 'drop-1' });
    clock.now = SWITCH_ON_MS;
    await expect(post(s, 'w')).rejects.toMatchObject({
      code: DEVICE_SIGNATURE_REQUIRED_CODE
    });
    for (const kind of KINDS) {
      await expect(mutate(s, kind, 'd')).rejects.toBeInstanceOf(
        DeviceSignatureRequiredException
      );
    }
    await expect(
      s.assertUnsignedChatRatingAllowed('d', ctx())
    ).rejects.toBeInstanceOf(DeviceSignatureRequiredException);
    // A staying wave and a direct message stay open.
    await expect(post(s, 'site-wave')).resolves.toEqual({ id: 'drop-1' });
    await expect(post(s, 'dm-wave')).resolves.toEqual({ id: 'drop-1' });
    for (const kind of KINDS) {
      await expect(mutate(s, kind, 's')).resolves.toEqual({ id: 'drop-1' });
      await expect(mutate(s, kind, 'dm')).resolves.toEqual({ id: 'drop-1' });
    }
    await expect(
      s.assertUnsignedChatRatingAllowed('s', ctx())
    ).resolves.toBeUndefined();
    await expect(
      s.assertUnsignedChatRatingAllowed('dm', ctx())
    ).resolves.toBeUndefined();
  });

  it('switches on with FEATURE_WAVES_ON_CHAIN, and never on a missing or malformed time', async () => {
    const { service: s } = service(waves, drops, ['site-wave']);
    clock.now = SWITCH_ON_MS + 60_000;
    delete process.env[SWITCH_ON_AT];
    await expect(post(s, 'w')).resolves.toEqual({ id: 'drop-1' });
    process.env[SWITCH_ON_AT] = 'Saturday';
    await expect(post(s, 'w')).resolves.toEqual({ id: 'drop-1' });
    process.env[ON_CHAIN] = 'true';
    await expect(post(s, 'w')).rejects.toBeInstanceOf(
      DeviceSignatureRequiredException
    );
    // Switched on, but the flag off: nothing is refused.
    delete process.env[FLAG];
    await expect(post(s, 'w')).resolves.toEqual({ id: 'drop-1' });
  });

  it('isDeviceSignatureRequired: the flag and the switch-on, at the time given', () => {
    const env = { [FLAG]: 'true', [SWITCH_ON_AT]: SWITCH_ON };
    expect(isDeviceSignatureRequired(env, SWITCH_ON_MS - 1)).toBe(false);
    expect(isDeviceSignatureRequired(env, SWITCH_ON_MS)).toBe(true);
    expect(
      isDeviceSignatureRequired({ ...env, [FLAG]: 'false' }, SWITCH_ON_MS)
    ).toBe(false);
    expect(
      isDeviceSignatureRequired({ [FLAG]: 'true', [ON_CHAIN]: 'true' }, 0)
    ).toBe(true);
    expect(isDeviceSignatureRequired({ [FLAG]: 'true' }, SWITCH_ON_MS)).toBe(
      false
    );
  });
});

describe('device signatures required: the flag with no switch-on set', () => {
  /** A fresh copy of the module (the warning is once a process), and its warnings. */
  async function freshRequirement() {
    let required!: (env: Record<string, string>, nowMillis: number) => boolean;
    let warn!: jest.SpyInstance;
    await jest.isolateModulesAsync(async () => {
      const { Logger: FreshLogger } = await import('@/logging');
      warn = jest
        .spyOn(FreshLogger.prototype, 'warn')
        .mockImplementation(() => undefined);
      required = (await import('./device-signed-writes.service'))
        .isDeviceSignatureRequired;
    });
    const warnings = () =>
      warn.mock.calls
        .map(([line]) => String(line))
        .filter((line) => line.startsWith('[DEVICE SIGNATURES NOT REQUIRED]'));
    return { required, warnings, restore: () => warn.mockRestore() };
  }

  it('refuses nothing, and warns once', async () => {
    const { required, warnings, restore } = await freshRequirement();
    const env = { [FLAG]: 'true' };
    expect(required(env, SWITCH_ON_MS)).toBe(false);
    expect(required(env, SWITCH_ON_MS + 1)).toBe(false);
    expect(warnings()).toEqual([
      '[DEVICE SIGNATURES NOT REQUIRED] FEATURE_WAVES_DEVICE_SIGNATURE_REQUIRED is true, but neither WAVES_SWITCH_ON_AT nor FEATURE_WAVES_ON_CHAIN is set: nothing is refused until one is'
    ]);
    restore();
  });

  it('says nothing with a switch-on time, with FEATURE_WAVES_ON_CHAIN, or with the flag off', async () => {
    const envs: Record<string, string>[] = [
      { [FLAG]: 'true', [SWITCH_ON_AT]: SWITCH_ON },
      { [FLAG]: 'true', [ON_CHAIN]: 'true' },
      {}
    ];
    for (const env of envs) {
      const { required, warnings, restore } = await freshRequirement();
      required(env, SWITCH_ON_MS - 1);
      expect(warnings()).toEqual([]);
      restore();
    }
  });
});
