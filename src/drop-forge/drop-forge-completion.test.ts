import { mirrorCompletion } from '@/drop-forge/drop-forge.completion';
import { mintingClaimActionsDb } from '@/api/minting-claims/minting-claim-actions.db';
import * as supported from '@/minting-claims/minting-claim-actions';
import * as held from '@/mint-log/mint-log-drop-forge';
import { testLaunchData } from '@/drop-forge/drop-forge.test-fixtures';
import { LaunchRecord } from '@/drop-forge/drop-forge.types';

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

it('leaves a held flag that failed to write unmirrored, warns once, and asks for it by hand on an ended launch', async () => {
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
  const warnings = () =>
    record.data.events
      .slice(before)
      .filter((event) =>
        event.content.includes('completion flag PAY_ARTIST was not written')
      );
  try {
    expect(await mirrorCompletion(record, {}, save)).toBe(true);
    await flushFailing();
    expect(record.data.completion_flags).toEqual([]);
    expect(warnings()).toHaveLength(1);
    // A running launch retries it: an event without the alert mention.
    expect(warnings()[0]).toMatchObject({ error: false });
    expect(warnings()[0].content).toContain(
      `(ER_LOCK_WAIT_TIMEOUT); Drop Forge writes it again on a later pass, before the launch completes (a paused or blocked launch only once it runs again). If the launch ends first, set it by hand: POST /api/minting-claims/actions/${record.data.contract}/${record.data.claim_id} with {"action":"PAY_ARTIST","completed":true}, as a claims admin (in primary mode with the admin's signed record, x-6529-signed-records).`
    );

    // The next pass holds it again; a second failure saves, warns no more.
    expect(await mirrorCompletion(record, {}, save)).toBe(true);
    await flushFailing();
    expect(warnings()).toHaveLength(1);
    expect(save).toHaveBeenCalledTimes(2);

    // On a launch that has ended, the warning asks for the flag by hand.
    record.state = 'COMPLETED';
    record.data.events = record.data.events.slice(0, before);
    await mirrorCompletion(record, {}, save);
    await flushFailing();
    // It needs an operator now: an error, with the alert mention. It names
    // the route, the action and the fields to send.
    expect(warnings()[0]).toMatchObject({ error: true });
    expect(warnings()[0].content).toContain(
      `the launch has ended, so set it by hand: POST /api/minting-claims/actions/${record.data.contract}/${record.data.claim_id} with {"action":"PAY_ARTIST","completed":true}, as a claims admin (in primary mode with the admin's signed record, x-6529-signed-records).`
    );
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

    // The next pass writes the deferred flag alone.
    expect(await mirrorCompletion(record, {}, save)).toBe(true);
    expect(actions.slice(3)).toEqual(['PHASE2_AIRDROP']);
    expect(record.data.completion_flags).toEqual([
      'PAY_ARTIST',
      'ARTIST_AIRDROP',
      'PHASE2_AIRDROP'
    ]);
    expect(save).not.toHaveBeenCalled();
  } finally {
    jest.restoreAllMocks();
  }
});
