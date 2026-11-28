import {
  OpeningState,
  STATE_RE_READ_MS,
  SubscriptionsIdentitySwitch,
  SWITCH_CUT_WINDOW_MS,
  switchReason
} from './identity-switch';

jest.mock('@/sql-executor', () => ({ sqlExecutor: {} }));
jest.mock('@/logging', () => ({
  Logger: { get: () => ({ error: jest.fn(), warn: jest.fn() }) }
}));

const SWITCH_MS = Date.parse('2026-11-26T12:00:00Z');
const live: OpeningState = {
  opening_sha256: 'abc',
  cut_at: SWITCH_MS - 60 * 1000,
  verified_at: SWITCH_MS - 30 * 1000,
  suspended_at: null,
  switch_at: SWITCH_MS
};

function makeSwitch(
  state: () => Promise<OpeningState | null>,
  nowMs: { value: number },
  shadow?: string
) {
  return new SubscriptionsIdentitySwitch(
    state,
    () => nowMs.value,
    () => shadow
  );
}

describe('the identity switch', () => {
  it('is the truth only from the switch time, on a verified, unsuspended cut taken at the switch', () => {
    expect(switchReason(null, SWITCH_MS)).toBe('NOT_LOADED');
    expect(switchReason({ ...live, switch_at: null }, SWITCH_MS)).toBe(
      'NO_SWITCH_TIME'
    );
    expect(switchReason(live, SWITCH_MS - 1)).toBe('BEFORE_SWITCH_TIME');
    expect(switchReason({ ...live, suspended_at: SWITCH_MS }, SWITCH_MS)).toBe(
      'SUSPENDED'
    );
    expect(switchReason({ ...live, verified_at: null }, SWITCH_MS)).toBe(
      'NOT_VERIFIED'
    );
    // An opening cut on Tuesday doesn't become Thursday's truth.
    expect(
      switchReason(
        { ...live, cut_at: SWITCH_MS - SWITCH_CUT_WINDOW_MS - 1 },
        SWITCH_MS
      )
    ).toBe('STALE_CUT');
    expect(switchReason(live, SWITCH_MS)).toBe('IDENTITY_TABLES');
  });

  it('writes in shadow only with the flag and a loaded, unsuspended opening', async () => {
    const now = { value: SWITCH_MS - 1 };
    const notYet = async () => ({ ...live, switch_at: null });
    expect(await makeSwitch(notYet, now).writeMode()).toBe('OFF');
    expect(await makeSwitch(notYet, now, 'true').writeMode()).toBe('SHADOW');
    expect(
      await makeSwitch(
        async () => ({ ...live, switch_at: null, suspended_at: 1 }),
        now,
        'true'
      ).writeMode()
    ).toBe('OFF');
    expect(await makeSwitch(async () => null, now, 'true').writeMode()).toBe(
      'OFF'
    );
    now.value = SWITCH_MS;
    expect(await makeSwitch(async () => live, now).writeMode()).toBe('TRUTH');
  });

  it('re-reads the state at least every 60 seconds, so a suspend reaches every reader', async () => {
    const now = { value: SWITCH_MS };
    let state: OpeningState = live;
    const read = jest.fn(async () => state);
    const s = makeSwitch(read, now);
    expect(await s.identityTablesAreTruth()).toBe(true);
    state = { ...live, suspended_at: SWITCH_MS + 1 };
    now.value += STATE_RE_READ_MS - 1;
    expect(await s.identityTablesAreTruth()).toBe(true);
    now.value += 1;
    expect(await s.identityTablesAreTruth()).toBe(false);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('keeps the last state read when a read fails; a legacy caller with none goes on alone', async () => {
    const now = { value: SWITCH_MS };
    const read = jest
      .fn<Promise<OpeningState | null>, []>()
      .mockResolvedValueOnce(live)
      .mockRejectedValue(new Error('db down'));
    const s = makeSwitch(read, now, 'true');
    expect(await s.writeMode()).toBe('TRUTH');
    now.value += STATE_RE_READ_MS;
    expect(await s.writeMode()).toBe('TRUTH');
    const fresh = makeSwitch(read, now, 'true');
    await expect(fresh.writeMode()).rejects.toThrow('db down');
    expect(await fresh.writeModeForLegacy()).toBe('OFF');
  });
});
