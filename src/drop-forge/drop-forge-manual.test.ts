import { claimAbi, LaunchChain } from '@/drop-forge/drop-forge.chain';
import { reconcileManual } from '@/drop-forge/drop-forge.manual';
import {
  testConfig,
  testLaunchData
} from '@/drop-forge/drop-forge.test-fixtures';
import { LaunchRecord } from '@/drop-forge/drop-forge.types';
import {
  isResearchAirdrop,
  RESEARCH_AIRDROP_ADDRESS
} from '@/drop-forge/drop-forge.research';
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

it('records confirmed manual research without crediting phase allocations or repeating the proof', async () => {
  const { record, chain, inspectTransaction, receipt } = setup();
  record.data.edition_size = 305;
  record.data.manual_transactions![0].action = 'RESEARCH_AIRDROP';
  inspectTransaction.mockResolvedValue({
    receipt,
    calldata: claimAbi.encodeFunctionData('airdrop', [
      record.data.contract,
      record.data.claim_id,
      [RESEARCH_AIRDROP_ADDRESS],
      [18]
    ])
  });
  await reconcileManual(record, chain, testConfig);
  const research = record.data.actions.find(isResearchAirdrop)!;
  expect(research.credited_tokens).toBe(18);
  expect(research.manual_hashes).toEqual(['manual-hash']);
  expect(research.state).toBe('PENDING');
  expect(record.data.actions[1].credited_tokens).toBeUndefined();
  await reconcileManual(record, chain, testConfig);
  expect(inspectTransaction).toHaveBeenCalledTimes(1);
  expect(research.credited_tokens).toBe(18);
  chain.receipt.mockResolvedValue(null);
  await expect(reconcileManual(record, chain, testConfig)).rejects.toThrow(
    'canonical'
  );
});

it('rejects a manual research declaration that sends tokens to another wallet', async () => {
  const { record, chain } = setup();
  record.data.manual_transactions![0].action = 'RESEARCH_AIRDROP';
  await expect(reconcileManual(record, chain, testConfig)).rejects.toThrow(
    'Manual research transaction'
  );
  expect(
    record.data.actions.find(isResearchAirdrop)!.credited_tokens
  ).toBeUndefined();
});

it('keeps the dynamic Research action pending after an ordinary undeclared manual airdrop', async () => {
  const { record, chain } = setup(1);
  const research = record.data.actions.find(isResearchAirdrop)!;
  expect(research.recipients).toEqual([]);
  await reconcileManual(record, chain, testConfig);
  expect(record.data.actions[1].state).toBe('CONFIRMED');
  expect(research.state).toBe('PENDING');
  expect(research.hash).toBeUndefined();
});
it('does not confirm an empty unrelated batch that this proof did not credit', async () => {
  const { record, chain } = setup(1);
  const empty = {
    ...record.data.actions[1],
    id: 'empty-category',
    recipients: []
  };
  record.data.actions.push(empty);
  await reconcileManual(record, chain, testConfig);
  expect(empty.state).toBe('PENDING');
});

it('credits a confirmed manual artist payment once without crediting airdrop allocations', async () => {
  const { record, chain, receipt } = setup();
  record.data.manual_transactions![0].action = 'PAY_ARTIST';
  const inspect = jest.fn().mockResolvedValue(receipt);
  chain.inspectPayment = inspect;
  const payment = record.data.actions.find(
    (action) => action.kind === 'PAY_ARTIST'
  )!;
  expect(await reconcileManual(record, chain, testConfig)).toBe(true);
  expect(payment).toMatchObject({
    state: 'CONFIRMED',
    hash: 'manual-hash',
    observed: true,
    block_hash: 'canonical'
  });
  expect(record.data.actions[1].credited_tokens).toBeUndefined();
  expect(record.data.manual_transactions![0]).toMatchObject({
    state: 'CONFIRMED',
    method: 'PAY_ARTIST'
  });
  await reconcileManual(record, chain, testConfig);
  expect(inspect).toHaveBeenCalledTimes(1);
});
it('defers unconfirmed artist payment evidence and does not release a signed intent', async () => {
  const { record, chain, receipt } = setup();
  record.data.manual_transactions![0].action = 'PAY_ARTIST';
  receipt.confirmations = 1;
  const inspect = jest.fn().mockResolvedValue(receipt);
  chain.inspectPayment = inspect;
  const payment = record.data.actions.find(
    (action) => action.kind === 'PAY_ARTIST'
  )!;
  expect(await reconcileManual(record, chain, testConfig)).toBe(false);
  expect(payment.state).toBe('PENDING');
  payment.state = 'SIGNED';
  await expect(reconcileManual(record, chain, testConfig)).rejects.toThrow(
    'signed intent'
  );
  expect(payment.state).toBe('SIGNED');
  expect(inspect).toHaveBeenCalledTimes(1);
});
