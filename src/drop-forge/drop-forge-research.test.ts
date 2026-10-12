import {
  researchAirdropAmount,
  RESEARCH_AIRDROP_ADDRESS,
  verifyResearchSupply,
  isResearchAirdrop
} from '@/drop-forge/drop-forge.research';
import { testLaunchData } from '@/drop-forge/drop-forge.test-fixtures';
import { assertPhaseScopedPlan } from '@/drop-forge/drop-forge.types';

it('requires the plan version that includes post-mint Research', () => {
  const data = testLaunchData();
  expect(() => assertPhaseScopedPlan(data)).not.toThrow();
  data.plan_version = 2;
  expect(() => assertPhaseScopedPlan(data)).toThrow('Legacy launch plan');
});

it.each([
  [305, 287, 18],
  [310, 287, 23],
  [500, 287, 23],
  [305, 305, 0],
  [500, 400, 0],
  [100, 90, 10]
])(
  'caps the research top-up by edition %i with total %i',
  (edition, total, expected) => {
    expect(researchAirdropAmount(total, edition)).toBe(expected);
  }
);
it.each([-1, 306, 1.5, NaN])('rejects invalid total %s', (total) => {
  expect(() => researchAirdropAmount(total, 305)).toThrow('Invalid research');
});
it('captures the late quantity once and refuses a changed supply or recipient before signing', () => {
  const data = testLaunchData();
  data.edition_size = 305;
  const action = data.actions.find(isResearchAirdrop)!;
  expect(() =>
    verifyResearchSupply(data, action, 287, action.due - 1, true)
  ).toThrow('fifteen minutes');
  verifyResearchSupply(data, action, 287, action.due, true);
  expect(action.recipients).toEqual([
    { address: RESEARCH_AIRDROP_ADDRESS, amount: 18 }
  ]);
  expect(() =>
    verifyResearchSupply(data, action, 288, action.due, false)
  ).toThrow('supply changed');
  expect(() =>
    verifyResearchSupply(data, action, 287, action.due, false)
  ).not.toThrow();
  action.recipients[0].amount = 23;
  expect(() =>
    verifyResearchSupply(data, action, 287, action.due, false)
  ).toThrow('remaining target');
});
