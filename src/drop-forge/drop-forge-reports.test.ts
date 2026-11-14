import {
  formatLaunchReport,
  formatOperationsPost
} from '@/drop-forge/drop-forge.reports';
import { testLaunchData } from '@/drop-forge/drop-forge.test-fixtures';
import { LaunchAction } from '@/drop-forge/drop-forge.types';

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
    `Claim #1: ${wording}. [Transaction](https://sepolia.etherscan.io/tx/${hash})`
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
