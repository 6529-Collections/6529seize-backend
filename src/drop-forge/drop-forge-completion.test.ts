import {
  alertOverdueLaunchFlags,
  completionFlagRows,
  FLAG_ALERT_AFTER_MS,
  hasUnwrittenFlags,
  mirrorCompletion
} from '@/drop-forge/drop-forge.completion';
import { mintingClaimActionsDb } from '@/api/minting-claims/minting-claim-actions.db';
import * as supported from '@/minting-claims/minting-claim-actions';
import * as held from '@/mint-log/mint-log-drop-forge';
import { testLaunchData } from '@/drop-forge/drop-forge.test-fixtures';
import { LaunchRecord } from '@/drop-forge/drop-forge.types';
import { mintLogRecorder } from '@/mint-log/mint-log-recorder';

it('mirrors only complete airdrop groups and does not duplicate shared completion flags', async () => {
  const record: LaunchRecord = {
    id: 'launch',
    revision: 1,
    state: 'RUNNING',
    error: null,
    updated_at: 1,
    data: testLaunchData()
  };
  const original = record.data.actions[1];
  record.data.actions = [
    {
      ...original,
      id: 'first',
      label: 'Phase 2 Subscription Airdrops',
      state: 'CONFIRMED'
    },
    {
      ...original,
      id: 'second',
      label: 'Phase 2 Subscription Airdrops',
      state: 'PENDING'
    },
    {
      ...original,
      id: 'public',
      label: 'Public Subscription Airdrops',
      state: 'PENDING'
    }
  ];
  jest
    .spyOn(supported, 'isSupportedMintingClaimActionType')
    .mockReturnValue(true);
  const upsert = jest
    .spyOn(mintingClaimActionsDb, 'upsertAction')
    .mockResolvedValue();
  const save = jest.fn().mockResolvedValue(undefined);
  try {
    await mirrorCompletion(record, {}, save);
    expect(upsert).not.toHaveBeenCalled();
    record.data.actions[1].state = 'CONFIRMED';
    record.data.actions[1].unfilled_tokens = 1;
    record.data.actions[2].state = 'SKIPPED';
    await mirrorCompletion(record, {}, save);
    expect(upsert).not.toHaveBeenCalled();
    delete record.data.actions[1].unfilled_tokens;
    // With the mint log off the flag is written here, so none is pending.
    expect(await mirrorCompletion(record, {}, save)).toBe(false);
    expect(upsert.mock.calls.map(([row]) => row.action)).toEqual([
      'PHASE2_AIRDROP'
    ]);
    record.data.actions[2].state = 'CONFIRMED';
    await mirrorCompletion(record, {}, save);
    await mirrorCompletion(record, {}, save);
    expect(upsert.mock.calls.map(([row]) => row.action)).toEqual([
      'PHASE2_AIRDROP',
      'PUBLIC_PHASE_AIRDROP'
    ]);
    // Written at once outside a signer transaction: nothing failed to store.
    expect(save).not.toHaveBeenCalled();
  } finally {
    jest.restoreAllMocks();
  }
});

it('leaves a held flag that failed to write unmirrored, raises one plain event, and alerts once if it is still unwritten after the set time', async () => {
  const record: LaunchRecord = {
    id: 'launch',
    revision: 1,
    state: 'RUNNING',
    error: null,
    updated_at: 1,
    data: testLaunchData()
  };
  record.data.actions = [
    {
      ...record.data.actions[0],
      id: 'pay',
      kind: 'PAY_ARTIST',
      state: 'CONFIRMED'
    }
  ];
  const before = record.data.events.length;
  jest
    .spyOn(supported, 'isSupportedMintingClaimActionType')
    .mockReturnValue(true);
  let now = 1_000_000;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  const queued: Parameters<typeof held.writeDropForgeClaimAction>[1][] = [];
  jest
    .spyOn(held, 'writeDropForgeClaimAction')
    .mockImplementation(async (_ctx, item) => {
      queued.push(item);
      return 'held';
    });
  // What the end of the signer transaction does when each write fails.
  const flushFailing = async () => {
    for (const item of queued.splice(0)) {
      await item.failed(
        Object.assign(new Error('Lock wait timeout exceeded'), {
          code: 'ER_LOCK_WAIT_TIMEOUT'
        })
      );
    }
  };
  const save = jest.fn().mockResolvedValue(undefined);
  const events = () =>
    record.data.events
      .slice(before)
      .filter((event) => event.content.includes('completion flag PAY_ARTIST'));
  const byHand = `set it by hand: POST /api/minting-claims/actions/${record.data.contract}/${record.data.claim_id} with {"action":"PAY_ARTIST","completed":true}, as a claims admin (in primary mode with the admin's signed record, x-6529-signed-records).`;
  try {
    expect(await mirrorCompletion(record, {}, save)).toBe(true);
    await flushFailing();
    expect(record.data.completion_flags).toEqual([]);
    expect(hasUnwrittenFlags(record)).toBe(true);
    expect(events()).toHaveLength(1);
    // Retried on its own: one plain event, no alert mention.
    expect(events()[0]).toMatchObject({ error: false });
    expect(events()[0].content).toContain(
      'completion flag PAY_ARTIST was not written (ER_LOCK_WAIT_TIMEOUT); Drop Forge writes it again on a later pass.'
    );

    // It fails on every later pass: still one event, a save each time.
    for (let pass = 0; pass < 3; pass++) {
      expect(await mirrorCompletion(record, {}, save)).toBe(true);
      await flushFailing();
    }
    expect(events()).toHaveLength(1);
    expect(save).toHaveBeenCalledTimes(4);

    // Within the set time of its first miss, still no alert.
    now += FLAG_ALERT_AFTER_MS - 1;
    await mirrorCompletion(record, {}, save);
    await flushFailing();
    expect(events()).toHaveLength(1);

    // Past it, one error with the alert mention asks for it by hand, once.
    now += 1;
    for (let pass = 0; pass < 2; pass++) {
      await mirrorCompletion(record, {}, save);
      await flushFailing();
    }
    expect(events()).toHaveLength(2);
    expect(events()[1]).toMatchObject({ error: true });
    expect(events()[1].content).toContain(
      `completion flag PAY_ARTIST is still not written 10 minutes after it was first missed; ${byHand}`
    );
  } finally {
    jest.restoreAllMocks();
  }
});

it('gives the code as the reason only when it is a string', async () => {
  const record: LaunchRecord = {
    id: 'launch',
    revision: 1,
    state: 'RUNNING',
    error: null,
    updated_at: 1,
    data: testLaunchData()
  };
  record.data.actions = [
    {
      ...record.data.actions[0],
      id: 'pay',
      kind: 'PAY_ARTIST',
      state: 'CONFIRMED'
    }
  ];
  jest
    .spyOn(supported, 'isSupportedMintingClaimActionType')
    .mockReturnValue(true);
  jest
    .spyOn(held, 'writeDropForgeClaimAction')
    .mockImplementation(async (_ctx, item) => {
      await item.failed(
        Object.assign(new Error('the write failed'), { code: undefined })
      );
      return 'held';
    });
  try {
    await mirrorCompletion(record, {}, jest.fn().mockResolvedValue(undefined));
    expect(record.data.events.at(-1)?.content).toContain(
      'completion flag PAY_ARTIST was not written (the write failed);'
    );
  } finally {
    jest.restoreAllMocks();
  }
});

it("with the mint log on, writes every retry of a flag only where the claim has no row, so an admin's row stays; a first write upserts", async () => {
  const record: LaunchRecord = {
    id: 'launch',
    revision: 1,
    state: 'CANCELLED',
    error: null,
    updated_at: 1,
    data: testLaunchData()
  };
  record.data.actions = [
    {
      ...record.data.actions[0],
      id: 'pay',
      kind: 'PAY_ARTIST',
      state: 'CONFIRMED'
    }
  ];
  jest
    .spyOn(supported, 'isSupportedMintingClaimActionType')
    .mockReturnValue(true);
  const writes: Parameters<typeof held.writeDropForgeClaimAction>[1][] = [];
  jest
    .spyOn(held, 'writeDropForgeClaimAction')
    .mockImplementation(async (_ctx, item) => {
      writes.push(item);
      return 'held';
    });
  const insert = jest
    .spyOn(completionFlagRows, 'insertIfAbsent')
    .mockResolvedValue();
  const upsert = jest
    .spyOn(mintingClaimActionsDb, 'upsertAction')
    .mockResolvedValue();
  const mode = jest.spyOn(mintLogRecorder, 'mode').mockReturnValue('shadow');
  const writeOnce = async (options = {}) => {
    record.data.completion_flags = [];
    writes.length = 0;
    insert.mockClear();
    upsert.mockClear();
    await mirrorCompletion(record, {}, jest.fn(), options);
    await writes[0]?.write({});
  };
  const missed = {
    id: 'launch:missed',
    content:
      'Claim #1: completion flag PAY_ARTIST was not written (ER_LOCK_WAIT_TIMEOUT); Drop Forge writes it again on a later pass.',
    error: false,
    at: 1
  };
  try {
    // A first write upserts, as a mirror always has.
    await writeOnce();
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(insert).not.toHaveBeenCalled();

    // A later delivery's retry writes only flags a pass missed: none yet.
    await writeOnce({ missedOnly: true });
    expect(writes).toEqual([]);
    expect(hasUnwrittenFlags(record)).toBe(false);

    // A flag a pass missed is a retry on any path: insert-only.
    record.data.events.push(missed);
    expect(hasUnwrittenFlags(record)).toBe(true);
    for (const options of [{}, { missedOnly: true }]) {
      await writeOnce(options);
      expect(insert).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'PAY_ARTIST',
          claim_id: record.data.claim_id
        }),
        {}
      );
      expect(upsert).not.toHaveBeenCalled();
    }
    expect(hasUnwrittenFlags(record)).toBe(false);

    // With the mint log off, a mirror upserts, as on main.
    mode.mockReturnValue('off');
    await writeOnce();
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(insert).not.toHaveBeenCalled();
  } finally {
    jest.restoreAllMocks();
  }
});

it('alerts once for a missed flag still unwritten after the set time, without a write, and reads nothing with the mint log off', async () => {
  const record: LaunchRecord = {
    id: 'launch',
    revision: 1,
    state: 'RUNNING',
    error: null,
    updated_at: 1,
    data: testLaunchData()
  };
  record.data.actions = [
    {
      ...record.data.actions[0],
      id: 'pay',
      kind: 'PAY_ARTIST',
      state: 'CONFIRMED'
    }
  ];
  record.data.completion_flags = [];
  jest
    .spyOn(supported, 'isSupportedMintingClaimActionType')
    .mockReturnValue(true);
  let now = 1_000_000;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  const mode = jest.spyOn(mintLogRecorder, 'mode').mockReturnValue('off');
  const repository = {
    find: jest.fn(async () => structuredClone(record)),
    change: jest.fn(
      async (_id: string, fn: (launch: LaunchRecord) => unknown) => {
        await fn(record);
      }
    )
  };
  const alerts = () =>
    record.data.events.filter((event) =>
      event.content.includes('completion flag PAY_ARTIST is still not written')
    );
  try {
    // With the mint log off: no read, no write.
    await alertOverdueLaunchFlags('launch', repository as never);
    expect(repository.find).not.toHaveBeenCalled();

    // A flag no pass missed: nothing to alert, nothing written.
    mode.mockReturnValue('shadow');
    await alertOverdueLaunchFlags('launch', repository as never);
    expect(repository.change).not.toHaveBeenCalled();

    // Missed, within the set time: still nothing written.
    record.data.events.push({
      id: 'launch:missed',
      content:
        'Claim #1: completion flag PAY_ARTIST was not written (ER_LOCK_WAIT_TIMEOUT); Drop Forge writes it again on a later pass.',
      error: false,
      at: now
    });
    now += FLAG_ALERT_AFTER_MS - 1;
    await alertOverdueLaunchFlags('launch', repository as never);
    expect(repository.change).not.toHaveBeenCalled();

    // Past it: one alert with the mention, written once, then no more.
    now += 1;
    await alertOverdueLaunchFlags('launch', repository as never);
    await alertOverdueLaunchFlags('launch', repository as never);
    expect(repository.change).toHaveBeenCalledTimes(1);
    expect(alerts()).toEqual([expect.objectContaining({ error: true })]);

    // A written flag needs none.
    record.data.events = record.data.events.filter(
      (event) => !event.content.includes('is still not written')
    );
    record.data.completion_flags = ['PAY_ARTIST'];
    await alertOverdueLaunchFlags('launch', repository as never);
    expect(repository.change).toHaveBeenCalledTimes(1);
  } finally {
    jest.restoreAllMocks();
  }
});

it('leaves a flag the pass has no room for unmirrored, for the next pass, and keeps the launch from completing', async () => {
  const record: LaunchRecord = {
    id: 'launch',
    revision: 1,
    state: 'RUNNING',
    error: null,
    updated_at: 1,
    data: testLaunchData()
  };
  const original = record.data.actions[1];
  record.data.actions = [
    {
      ...record.data.actions[0],
      id: 'pay',
      kind: 'PAY_ARTIST',
      state: 'CONFIRMED'
    },
    {
      ...original,
      id: 'artist',
      label: 'Airdrop - Artist',
      state: 'CONFIRMED'
    },
    {
      ...original,
      id: 'phase2',
      label: 'Phase 2 Subscription Airdrops',
      state: 'CONFIRMED'
    }
  ];
  jest
    .spyOn(supported, 'isSupportedMintingClaimActionType')
    .mockReturnValue(true);
  // The pass holds two flags; the third is deferred, as the cap does.
  const outcomes: held.ClaimActionWrite[] = ['held', 'held', 'deferred'];
  const actions: string[] = [];
  jest
    .spyOn(held, 'writeDropForgeClaimAction')
    .mockImplementation(async (_ctx, item) => {
      actions.push(item.action);
      return outcomes.shift() ?? 'held';
    });
  const save = jest.fn().mockResolvedValue(undefined);
  try {
    expect(await mirrorCompletion(record, {}, save)).toBe(true);
    expect(actions).toEqual(['PAY_ARTIST', 'ARTIST_AIRDROP', 'PHASE2_AIRDROP']);
    expect(record.data.completion_flags).toEqual([
      'PAY_ARTIST',
      'ARTIST_AIRDROP'
    ]);

    // One plain event says so, and the launch is saved with it.
    expect(save).toHaveBeenCalledTimes(1);
    expect(record.data.events.at(-1)).toMatchObject({
      error: false,
      content: expect.stringContaining(
        'completion flag PHASE2_AIRDROP was not written (the pass already holds two flags); Drop Forge writes it again on a later pass.'
      )
    });
    expect(hasUnwrittenFlags(record)).toBe(true);

    // The next pass writes the deferred flag alone.
    expect(await mirrorCompletion(record, {}, save)).toBe(true);
    expect(actions.slice(3)).toEqual(['PHASE2_AIRDROP']);
    expect(record.data.completion_flags).toEqual([
      'PAY_ARTIST',
      'ARTIST_AIRDROP',
      'PHASE2_AIRDROP'
    ]);
    expect(hasUnwrittenFlags(record)).toBe(false);
  } finally {
    jest.restoreAllMocks();
  }
});
