import {
  formatLaunchReport,
  formatOperationsPost
} from '@/drop-forge/drop-forge.reports';
import { testLaunchData } from '@/drop-forge/drop-forge.test-fixtures';
import { LaunchAction } from '@/drop-forge/drop-forge.types';
import {
  LaunchRecord,
  LaunchWalletBlockError
} from '@/drop-forge/drop-forge.types';
import { reportActionFailure } from '@/drop-forge/drop-forge.groups';
import { recordWalletBlock } from '@/drop-forge/drop-forge.wallet-retry';
import { testConfig } from '@/drop-forge/drop-forge.test-fixtures';

it.each<[LaunchAction['kind'], string]>([
  ['INITIALIZE', 'initialized'],
  ['METADATA', 'metadata updated'],
  ['UPDATE', 'Phase 0 configured']
])('reports confirmed %s with its transaction link', (kind, wording) => {
  const data = testLaunchData();
  const action = { ...data.actions[0], kind };
  data.actions = [action];
  const hash = '0x' + 'ab'.repeat(32);
  const report = formatLaunchReport(data, {
    id: 'event',
    at: 1,
    error: false,
    content: `Confirmed ${action.id}: ${hash}`
  });
  expect(report).toContain(
    `${wording}. [Transaction](https://sepolia.etherscan.io/tx/${hash})`
  );
});

it('reports a partial airdrop batch before reporting the group as completed', () => {
  const data = testLaunchData();
  const first = {
    ...data.actions[1],
    id: 'batch-1',
    label: 'Airdrop - Artist',
    state: 'CONFIRMED' as const
  };
  const second = {
    ...first,
    id: 'batch-2',
    state: 'PENDING' as LaunchAction['state']
  };
  data.actions = [first, second];
  const event = {
    id: 'event',
    at: 1,
    error: false,
    content: 'Confirmed batch-1: no hash'
  };
  expect(formatLaunchReport(data, event)).toContain(
    'Artist airdrops confirmed.'
  );
  expect(formatLaunchReport(data, event)).toContain('Batch 1 of 2');
  second.state = 'CONFIRMED';
  const last = formatLaunchReport(data, {
    ...event,
    content: 'Confirmed batch-2: no hash',
    fee_wei: '2100000000000000'
  });
  expect(last).toContain('Artist airdrops completed.');
  expect(last).toContain('Batch 2 of 2');
  expect(last).toContain('Gas 0.0021 ETH');
  expect(last).toContain(
    '[Claim #1](https://staging.6529.io/drop-forge/launch/1)'
  );
});

it.each([
  ['Confirmed x', false, '✅'],
  ['Signed x', false, '✍️'],
  ['Reserved x', false, '⏳'],
  ['Skipped x', false, '⏭️'],
  ['failed', true, '⚠️']
])('keeps %s posts compact with a type emoji', (content, error, emoji) => {
  const message = formatLaunchReport(testLaunchData(), {
    id: 'event',
    at: 1,
    content,
    error
  });
  expect(message.startsWith(emoji)).toBe(true);
  expect(message).not.toMatch(/^#/m);
  expect(formatOperationsPost(message, error)).toBe(message);
});

it.each([
  ['is Ready ✅', false],
  ['needs attention ⚠️', true],
  ['needs attention 🚨', true]
])('keeps the Mint Watch prefix first when a phase %s', (ending, error) => {
  const message = `[👀 MINT WATCH] **Meme #1** · Phase 0 ${ending}`;
  expect(formatOperationsPost(message, error)).toBe(message);
});

it('prints the exact capped artist allocation with a verified ENS label', () => {
  const data = testLaunchData();
  const action = data.actions[1];
  action.label = 'Airdrop - Artist';
  const address = action.recipients[0].address;
  const attempted = { ...action, capped_recipients: [{ address, amount: 20 }] };
  const record: LaunchRecord = {
    id: 'launch',
    data,
    state: 'ARMED',
    revision: 1,
    error: null,
    updated_at: 0
  };
  const error = new LaunchWalletBlockError('ADMIN_REQUIRED');
  reportActionFailure(record, action, 1000, error.message, error, undefined, {
    attempted,
    walletRetry: 3600
  });
  const post = formatLaunchReport(data, data.events[0], {
    claimLabels: '**Claim #1** · **Meme #1**',
    recipientEns: 'artist.eth'
  });
  expect(post).toContain('Planned artist airdrop · 20 cards to artist.eth');
  expect(post).toContain('/address/' + address);
  expect(post).toContain('Next attempt · 1 Jan 1970, 01:00 UTC');
});

it('gives a phase wallet block one scheduled retry, then waits for the operator', () => {
  const data = testLaunchData();
  const record: LaunchRecord = {
    id: 'launch',
    data,
    state: 'ARMED',
    revision: 1,
    error: null,
    updated_at: 0
  };
  const init = data.actions[0];
  const retry = recordWalletBlock(
    record,
    init,
    testConfig,
    'INSUFFICIENT_ETH',
    1100
  );
  expect(retry).toBeGreaterThan(1160);
  expect(
    recordWalletBlock(record, init, testConfig, 'ADMIN_REQUIRED', retry!)
  ).toBeNull();
  expect(record.data.wallet_blocks?.['phase-0']).toEqual({
    reason: 'ADMIN_REQUIRED',
    attempts: 2,
    retry_at: null
  });
});
