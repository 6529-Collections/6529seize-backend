import { claimAbi, LaunchChain } from '@/drop-forge/drop-forge.chain';
import { reconcileManual } from '@/drop-forge/drop-forge.manual';
import {
  testConfig,
  testLaunchData
} from '@/drop-forge/drop-forge.test-fixtures';
import { LaunchRecord } from '@/drop-forge/drop-forge.types';
function setup(amount = 2) {
  const data = testLaunchData();
  data.actions[1].recipients[0].amount = amount;
  data.manual_transactions = [{ hash: 'manual-hash', state: 'PENDING' }];
  const record: LaunchRecord = {
    id: 'launch',
    revision: 1,
    state: 'RUNNING',
    error: null,
    data,
    updated_at: 1
  };
  const receipt = {
    status: 1,
    blockNumber: 10,
    blockHash: 'canonical',
    confirmations: 12
  };
  const inspectTransaction = jest.fn().mockResolvedValue({
    receipt,
    calldata: claimAbi.encodeFunctionData('airdrop', [
      data.contract,
      data.claim_id,
      [data.actions[1].recipients[0].address],
      [1]
    ])
  });
  const chain = {
    inspectTransaction,
    receipt: jest.fn().mockResolvedValue(receipt)
  } as unknown as jest.Mocked<LaunchChain>;
  return { record, chain, receipt, inspectTransaction };
}
it('credits only the sent portion and retains the remaining allocation across duplicate reconciliation', async () => {
  const { record, chain } = setup();
  expect(await reconcileManual(record, chain, testConfig)).toBe(true);
  expect(record.data.actions[1].remaining_recipients?.[0].amount).toBe(1);
  expect(record.data.actions[1].state).toBe('PENDING');
  await reconcileManual(record, chain, testConfig);
  expect(chain.inspectTransaction).toHaveBeenCalledTimes(1);
  expect(record.data.actions[1].credited_tokens).toBe(1);
});
it('completes a fully credited batch with its canonical transaction evidence', async () => {
  const { record, chain } = setup(1);
  await reconcileManual(record, chain, testConfig);
  expect(record.data.actions[1].state).toBe('CONFIRMED');
  expect(record.data.actions[1].hash).toBe('manual-hash');
  expect(
    record.data.events.some((event) => event.content.includes('manual-hash'))
  ).toBe(true);
});
it('does not credit unconfirmed evidence, excess allocations or a reorg', async () => {
  const { record, chain, receipt } = setup(1);
  receipt.confirmations = 1;
  expect(await reconcileManual(record, chain, testConfig)).toBe(false);
  expect(record.data.actions[1].state).toBe('PENDING');
  receipt.confirmations = 12;
  await reconcileManual(record, chain, testConfig);
  chain.receipt.mockResolvedValue(null);
  await expect(reconcileManual(record, chain, testConfig)).rejects.toThrow(
    'canonical'
  );
  const another = setup(0);
  await expect(
    reconcileManual(another.record, another.chain, testConfig)
  ).rejects.toThrow('exceeds');
  expect(another.record.data.actions[1].credited_tokens).toBeUndefined();
});

it('credits the declared category when artist and team share a recipient', async () => {
  const { record, chain } = setup(1);
  const artist = record.data.actions[1];
  artist.label = 'Airdrop - Artist';
  const team = {
    ...artist,
    id: 'team',
    label: 'Airdrop - Team',
    recipients: artist.recipients.map((row) => ({ ...row }))
  };
  record.data.actions.push(team);
  record.data.manual_transactions![0].action = 'TEAM_AIRDROP';
  await reconcileManual(record, chain, testConfig);
  expect(artist.state).toBe('PENDING');
  expect(artist.credited_tokens).toBeUndefined();
  expect(team.state).toBe('CONFIRMED');
  expect(team.credited_tokens).toBe(1);
});

it('retains reverted evidence without credit and can reconcile after explicit recovery', async () => {
  const { record, chain, receipt } = setup();
  receipt.status = 0;
  await expect(reconcileManual(record, chain, testConfig)).rejects.toThrow(
    'reverted'
  );
  expect(record.data.manual_transactions![0].state).toBe('FAILED');
  expect(record.data.actions[1].credited_tokens).toBeUndefined();
  expect(await reconcileManual(record, chain, testConfig)).toBe(true);
  expect(chain.inspectTransaction).toHaveBeenCalledTimes(1);
});

it('blocks ambiguous undeclared categories before allocating any credits', async () => {
  const { record, chain } = setup(1);
  const first = record.data.actions[1];
  first.label = 'Airdrop - Artist';
  record.data.actions.push({ ...first, id: 'team', label: 'Airdrop - Team' });
  await expect(reconcileManual(record, chain, testConfig)).rejects.toThrow(
    'ambiguous'
  );
  expect(first.credited_tokens).toBeUndefined();
});
