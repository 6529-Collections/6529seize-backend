import {
  OpeningState,
  STATE_RE_READ_MS,
  SubscriptionsIdentitySwitch
} from './identity-switch';

jest.mock('@/sql-executor', () => ({ sqlExecutor: {} }));
jest.mock('@/logging', () => ({
  Logger: { get: () => ({ error: jest.fn(), warn: jest.fn() }) }
}));

const FROM = '2026-11-26T12:00:00Z';
const FROM_MS = Date.parse(FROM);
const verified: OpeningState = {
  opening_sha256: 'abc',
  verified_at: FROM_MS - 1000,
  suspended_at: null
};

function makeSwitch(
  flag: string | undefined,
  state: () => Promise<OpeningState | null>,
  nowMs: { value: number }
) {
  return new SubscriptionsIdentitySwitch(
    state,
    () => nowMs.value,
    () => flag
  );
}

describe('SubscriptionsIdentitySwitch', () => {
  it('keeps the legacy tables without a valid flag or before its time', async () => {
    const now = { value: FROM_MS + 1 };
    const read = jest.fn(async () => verified);
    expect((await makeSwitch(undefined, read, now).status()).reason).toBe(
      'FLAG_UNSET'
    );
    expect((await makeSwitch('tomorrow', read, now).status()).reason).toBe(
      'FLAG_INVALID'
    );
    now.value = FROM_MS - 1;
    expect((await makeSwitch(FROM, read, now).status()).reason).toBe(
      'BEFORE_SWITCH_TIME'
    );
    expect(read).not.toHaveBeenCalled();
  });

  it('needs the opening loaded and verified, and not suspended', async () => {
    const now = { value: FROM_MS };
    const status = async (state: OpeningState | null) =>
      (await makeSwitch(FROM, async () => state, now).status()).reason;
    expect(await status(null)).toBe('NOT_LOADED');
    expect(await status({ ...verified, verified_at: null })).toBe(
      'NOT_VERIFIED'
    );
    expect(await status({ ...verified, suspended_at: FROM_MS })).toBe(
      'SUSPENDED'
    );
    expect(await status(verified)).toBe('IDENTITY_TABLES');
  });

  it('re-reads the state at least every 60 seconds, so a suspend reaches every reader', async () => {
    const now = { value: FROM_MS };
    let state: OpeningState = verified;
    const read = jest.fn(async () => state);
    const s = makeSwitch(FROM, read, now);
    expect(await s.identityTablesAreTruth()).toBe(true);
    state = { ...verified, suspended_at: FROM_MS + 1 };
    now.value += STATE_RE_READ_MS - 1;
    expect(await s.identityTablesAreTruth()).toBe(true);
    now.value += 1;
    expect(await s.identityTablesAreTruth()).toBe(false);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('keeps the last state read when a read fails, and throws with none', async () => {
    const now = { value: FROM_MS };
    const read = jest
      .fn<Promise<OpeningState | null>, []>()
      .mockResolvedValueOnce(verified)
      .mockRejectedValue(new Error('db down'));
    const s = makeSwitch(FROM, read, now);
    expect(await s.identityTablesAreTruth()).toBe(true);
    now.value += STATE_RE_READ_MS;
    expect(await s.identityTablesAreTruth()).toBe(true);
    await expect(
      makeSwitch(FROM, read, now).identityTablesAreTruth()
    ).rejects.toThrow('db down');
  });
});
