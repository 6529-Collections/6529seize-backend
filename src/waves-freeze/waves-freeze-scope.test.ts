import { stubWavesScope } from '@/tests/fixtures/waves-scope.fixture';
import { WavesFrozenException } from '@/waves-freeze/waves-freeze';
import {
  assertDecisionWritable,
  assertEntriesWritable,
  assertWaveCreationOpen,
  assertWaveWritable,
  isAnyGroupFrozen,
  isDecisionFrozenNow,
  isWaveFrozen,
  keepingWaveScope
} from '@/waves-freeze/waves-freeze-scope';
import { wavesScopeService } from '@/waves-scope/waves-scope.service';

const FLAG = 'FEATURE_WAVES_FROZEN';
const KEEP = 'FEATURE_WAVES_FREEZE_KEEP_MAIN_STAGE';
const AT = 'WAVES_FREEZE_AT';
const MAIN_STAGE_WAVE = 'MAIN_STAGE_WAVE_ID';
const ENV_NAMES = [FLAG, KEEP, AT, MAIN_STAGE_WAVE];

describe('the waves freeze holds only what moves', () => {
  const original: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const name of ENV_NAMES) original[name] = process.env[name];
  });
  beforeEach(() => {
    for (const name of ENV_NAMES) delete process.env[name];
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(() => {
    for (const name of ENV_NAMES) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
  });

  it('reads nothing and refuses nothing when waves are not frozen', async () => {
    const scope = stubWavesScope();
    await expect(assertWaveWritable('moving', {})).resolves.toBeUndefined();
    await expect(
      assertDecisionWritable({ wave_id: 'moving' }, {})
    ).resolves.toBeUndefined();
    expect(() => assertWaveCreationOpen()).not.toThrow();
    expect(await isAnyGroupFrozen(['g'], {})).toBe(false);
    expect(await keepingWaveScope('moving', {}, async () => 'written')).toBe(
      'written'
    );
    expect(scope.waveStays).not.toHaveBeenCalled();
    expect(scope.usedByMovingWave).not.toHaveBeenCalled();
  });

  it('lets a write to a staying wave through while frozen, and refuses a moving one', async () => {
    process.env[FLAG] = 'true';
    stubWavesScope({ staying: ['members-only'] });
    await expect(
      assertWaveWritable('members-only', {})
    ).resolves.toBeUndefined();
    expect(await isWaveFrozen('members-only', {})).toBe(false);
    await expect(assertWaveWritable('public', {})).rejects.toBeInstanceOf(
      WavesFrozenException
    );
    expect(await isWaveFrozen('public', {})).toBe(true);
    // A write that names no wave is not let through.
    await expect(assertWaveWritable(null, {})).rejects.toBeInstanceOf(
      WavesFrozenException
    );
  });

  it("holds a decision with its wave; a staying wave's decisions go on", async () => {
    process.env[FLAG] = 'true';
    stubWavesScope({ staying: ['members-only'] });
    await expect(
      assertDecisionWritable({ capabilities: [], wave_id: 'members-only' }, {})
    ).resolves.toBeUndefined();
    await expect(
      assertDecisionWritable({ capabilities: [], wave_id: 'public' }, {})
    ).rejects.toBeInstanceOf(WavesFrozenException);
    // A migrated decision named only by its legacy wave.
    expect(
      await isDecisionFrozenNow({ legacy_wave_id: 'members-only' }, {})
    ).toBe(false);
  });

  it('keeps the Main Stage running when the freeze keeps it, without reading its wave', async () => {
    process.env[FLAG] = 'true';
    process.env[KEEP] = 'true';
    const scope = stubWavesScope();
    await expect(
      assertDecisionWritable(
        { capabilities: ['MAIN_STAGE'], wave_id: 'public' },
        {}
      )
    ).resolves.toBeUndefined();
    expect(scope.waveStays).not.toHaveBeenCalled();
  });

  it("checks each entry against its own decision, not its wave's", async () => {
    process.env[FLAG] = 'true';
    process.env[KEEP] = 'true';
    process.env[MAIN_STAGE_WAVE] = 'public';
    const scope = stubWavesScope();
    scope.decisionRefs.mockResolvedValue(
      new Map([
        [
          'main-stage',
          {
            wave_id: 'public',
            legacy_wave_id: null,
            capabilities: ['MAIN_STAGE']
          }
        ],
        [
          'side-decision',
          { wave_id: 'public', legacy_wave_id: null, capabilities: [] }
        ]
      ])
    );
    await expect(
      assertEntriesWritable(
        [{ competition_id: 'main-stage', wave_id: 'public' }],
        {}
      )
    ).resolves.toBeUndefined();
    // Same wave as the Main Stage's, but another decision: held.
    await expect(
      assertEntriesWritable(
        [
          { competition_id: 'main-stage', wave_id: 'public' },
          { competition_id: 'side-decision', wave_id: 'public' }
        ],
        {}
      )
    ).rejects.toBeInstanceOf(WavesFrozenException);
    // An entry whose decision has no row falls back to its wave.
    await expect(
      assertEntriesWritable([{ competition_id: 'gone', wave_id: 'public' }], {})
    ).resolves.toBeUndefined();
    expect(scope.decisionRefs).toHaveBeenCalledWith(
      ['main-stage', 'side-decision'],
      {}
    );
  });

  it('makes no new wave while frozen, whatever side it would be on', () => {
    process.env[FLAG] = 'true';
    expect(() => assertWaveCreationOpen()).toThrow(WavesFrozenException);
    delete process.env[FLAG];
    expect(() => assertWaveCreationOpen()).not.toThrow();
  });

  it('holds a public group a moving and a staying wave both use, and frees one only staying waves use', async () => {
    process.env[FLAG] = 'true';
    const scope = stubWavesScope({ movingWaveGroups: ['shared'] });
    expect(await isAnyGroupFrozen(['shared', null], {})).toBe(true);
    expect(await isAnyGroupFrozen(['members', undefined], {})).toBe(false);
    expect(scope.usedByMovingWave).toHaveBeenLastCalledWith(['members'], {});
  });

  it('refuses a write that moves a wave to the other side while frozen', async () => {
    process.env[FLAG] = 'true';
    let staysNow = true;
    jest
      .spyOn(wavesScopeService, 'waveStays')
      .mockImplementation(async () => staysNow);
    const write = jest.fn(async () => {
      staysNow = false;
      return 'written';
    });
    await expect(keepingWaveScope('w', {}, write)).rejects.toBeInstanceOf(
      WavesFrozenException
    );
    expect(write).toHaveBeenCalledTimes(1);

    staysNow = false;
    const makesItStay = jest.fn(async () => {
      staysNow = true;
    });
    await expect(keepingWaveScope('w', {}, makesItStay)).rejects.toBeInstanceOf(
      WavesFrozenException
    );

    const keeps = jest.fn(async () => 'kept');
    expect(await keepingWaveScope('w', {}, keeps)).toBe('kept');
  });
});
