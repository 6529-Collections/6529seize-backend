import { DropCreationApiService } from '@/api/drops/drop-creation.api.service';
import { Time } from '@/time';
import {
  WAVES_ON_CHAIN_CODE,
  WAVES_ON_CHAIN_MESSAGE,
  WavesOnChainException
} from '@/waves-freeze/waves-freeze';
import { stubWavesScope } from '@/tests/fixtures/waves-scope.fixture';

const NAMES = [
  'FEATURE_WAVES_ON_CHAIN',
  'WAVES_SWITCH_ON_AT',
  'WAVES_FREEZE_AT'
];
const SWITCH_ON = Date.UTC(2026, 10, 28);
const PAST_THE_CHECK = new Error('past the switch-on check');

function setup(wave: { id: string; is_direct_message?: boolean }) {
  const connection = {};
  const dropsDb = {
    executeNativeQueriesInTransaction: jest.fn(async (callback) =>
      callback(connection)
    )
  };
  const purgeDb = {
    findCutoff: jest.fn().mockRejectedValue(PAST_THE_CHECK),
    findBatchForUpdate: jest.fn().mockRejectedValue(PAST_THE_CHECK)
  };
  const waves = {
    findWaveByIdForUpdate: jest.fn().mockResolvedValue({
      description_drop_id: null,
      visibility_group_id: null,
      is_direct_message: false,
      ...wave
    })
  };
  const service = new DropCreationApiService(
    {} as never,
    dropsDb as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    waves as never,
    purgeDb as never
  );
  const ctx = {
    authenticationContext: {
      getActingAsId: jest.fn().mockReturnValue('author'),
      isAuthenticatedAsProxy: jest.fn().mockReturnValue(false)
    }
  } as never;
  return {
    purgeDb,
    prepare: () =>
      service.prepareMyWaveChatHistoryPurge({ waveId: wave.id }, ctx),
    purge: () => service.deleteMyWaveChatHistory({ waveId: wave.id }, ctx)
  };
}

describe('deleting your own chat history from the switch-on', () => {
  const original: Record<string, string | undefined> = {};
  let now: jest.SpyInstance;
  beforeAll(() => {
    for (const name of NAMES) original[name] = process.env[name];
  });
  beforeEach(() => {
    for (const name of NAMES) delete process.env[name];
    process.env.WAVES_SWITCH_ON_AT = new Date(SWITCH_ON).toISOString();
    now = jest.spyOn(Time, 'currentMillis').mockReturnValue(SWITCH_ON + 1);
    // Direct messages always stay on 6529.io; so does staying-wave.
    stubWavesScope({ staying: ['staying-wave', 'dm-wave'] });
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });
  afterAll(() => {
    for (const name of NAMES) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
  });

  it('refuses both steps in a moved wave with 423 WAVES_ON_CHAIN, deleting nothing', async () => {
    const { purgeDb, prepare, purge } = setup({ id: 'moved-wave' });
    for (const step of [prepare, purge]) {
      const error = await step().catch((e) => e);
      expect(error).toBeInstanceOf(WavesOnChainException);
      expect(error.getStatusCode()).toBe(423);
      expect(error.code).toBe(WAVES_ON_CHAIN_CODE);
      expect(error.message).toBe(WAVES_ON_CHAIN_MESSAGE);
    }
    expect(purgeDb.findCutoff).not.toHaveBeenCalled();
    expect(purgeDb.findBatchForUpdate).not.toHaveBeenCalled();
  });

  it('purges in a staying wave and a direct message as before', async () => {
    for (const wave of [
      { id: 'staying-wave' },
      { id: 'dm-wave', is_direct_message: true }
    ]) {
      const { prepare, purge } = setup(wave);
      await expect(prepare()).rejects.toBe(PAST_THE_CHECK);
      await expect(purge()).rejects.toBe(PAST_THE_CHECK);
    }
  });

  it('purges in every wave before the switch-on', async () => {
    now.mockReturnValue(SWITCH_ON - 1);
    const { prepare, purge } = setup({ id: 'moved-wave' });
    await expect(prepare()).rejects.toBe(PAST_THE_CHECK);
    await expect(purge()).rejects.toBe(PAST_THE_CHECK);
  });
});
