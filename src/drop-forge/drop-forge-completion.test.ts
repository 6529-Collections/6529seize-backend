import { mirrorCompletion } from '@/drop-forge/drop-forge.completion';
import { mintingClaimActionsDb } from '@/api/minting-claims/minting-claim-actions.db';
import * as supported from '@/minting-claims/minting-claim-actions';
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
      state: 'CONFIRMED'
    }
  ];
  jest
    .spyOn(supported, 'isSupportedMintingClaimActionType')
    .mockReturnValue(true);
  const upsert = jest
    .spyOn(mintingClaimActionsDb, 'upsertAction')
    .mockResolvedValue();
  try {
    await mirrorCompletion(record, {});
    expect(upsert.mock.calls.map(([row]) => row.action)).toEqual([
      'PUBLIC_PHASE_AIRDROP'
    ]);
    record.data.actions[1].state = 'CONFIRMED';
    await mirrorCompletion(record, {});
    await mirrorCompletion(record, {});
    expect(upsert.mock.calls.map(([row]) => row.action)).toEqual([
      'PUBLIC_PHASE_AIRDROP',
      'PHASE2_AIRDROP'
    ]);
  } finally {
    jest.restoreAllMocks();
  }
});
