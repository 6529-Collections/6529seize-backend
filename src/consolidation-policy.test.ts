import {
  getConsolidationPolicy,
  CONSOLIDATION_ACTIVATION_ENV
} from './consolidation-policy';
import { seizeSettings } from './api-serverless/src/seize-settings';
import { ConsolidationTools } from './consolidation-tools';

const original = process.env[CONSOLIDATION_ACTIVATION_ENV];
afterEach(() => {
  if (original === undefined) delete process.env[CONSOLIDATION_ACTIVATION_ENV];
  else process.env[CONSOLIDATION_ACTIVATION_ENV] = original;
});

test.each(['2026-10-15T00:00:00Z', '2026-10-12T00:00:00Z'])(
  'settings and grouping share environment cutoff %s',
  (cutoff) => {
    process.env[CONSOLIDATION_ACTIVATION_ENV] = cutoff;
    const policy = getConsolidationPolicy();
    expect(seizeSettings().consolidation).toEqual(policy);
    expect(
      Date.parse(policy.four_wallet_signing_opens_at) -
        Date.parse(policy.four_wallet_activation_at)
    ).toBe(600000);
    const tools = new ConsolidationTools();
    const registeredAt = Date.parse('2026-10-12T01:00:00Z') / 1000;
    const wallets = ['a', 'b', 'c', 'd'];
    const links = wallets.flatMap((wallet1, i) =>
      wallets.slice(i + 1).map((wallet2) => ({
        wallet1,
        wallet2,
        block: 1,
        wallet1_registered_at: registeredAt,
        wallet2_registered_at: registeredAt
      }))
    );
    const groups = tools.extractConsolidations(links);
    expect(groups.some((group) => group.length === 4)).toBe(
      cutoff.includes('10-12')
    );
  }
);

test.each([
  undefined,
  '',
  'soon',
  '2026-10-15T00:00:00',
  '2026-02-30T00:00:00Z',
  '2026-10-15T24:00:00Z',
  '2026-10-15T00:00:00.123Z'
])('rejects absent or invalid cutoff %s', (value) => {
  if (value === undefined) delete process.env[CONSOLIDATION_ACTIVATION_ENV];
  else process.env[CONSOLIDATION_ACTIVATION_ENV] = value;
  expect(getConsolidationPolicy).toThrow(CONSOLIDATION_ACTIVATION_ENV);
  expect(() => new ConsolidationTools().extractConsolidations([])).toThrow(
    CONSOLIDATION_ACTIVATION_ENV
  );
});

test('validates each configured value once and still rejects a bad one', () => {
  process.env[CONSOLIDATION_ACTIVATION_ENV] = '2026-10-15T00:00:00Z';
  const first = getConsolidationPolicy();
  expect(getConsolidationPolicy()).toBe(first);
  expect(Object.isFrozen(first)).toBe(true);

  process.env[CONSOLIDATION_ACTIVATION_ENV] = '2026-10-12T00:00:00Z';
  expect(getConsolidationPolicy().four_wallet_activation_at).toBe(
    '2026-10-12T00:00:00.000Z'
  );

  process.env[CONSOLIDATION_ACTIVATION_ENV] = 'soon';
  expect(getConsolidationPolicy).toThrow(CONSOLIDATION_ACTIVATION_ENV);
  expect(getConsolidationPolicy).toThrow(CONSOLIDATION_ACTIVATION_ENV);
});

test('accepts a valid time that is not midnight', () => {
  process.env[CONSOLIDATION_ACTIVATION_ENV] = '2026-10-15T13:45:30Z';
  expect(getConsolidationPolicy()).toEqual({
    four_wallet_activation_at: '2026-10-15T13:45:30.000Z',
    four_wallet_signing_opens_at: '2026-10-15T13:55:30.000Z'
  });
});
