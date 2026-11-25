import * as emma from '@/api/subscriptions/api.subscriptions.allowlist';
import * as preparation from '@/drop-forge/drop-forge.preparation';
import { processStep } from '@/drop-forge/drop-forge.workflow';
import { DropForgeJobEntity } from '@/entities/IDropForgeLaunch';

jest.mock('@/api/subscriptions/api.subscriptions.allowlist');
jest.mock('@/drop-forge/drop-forge.preparation');

const job = Object.assign(new DropForgeJobEntity(), {
  contract: 'contract',
  claim_id: 1,
  plan_id: 'plan',
  phase_ids: ['zero', 'one', 'two'],
  step: 0
});
const phases = [
  { id: 'two', name: '2' },
  { id: 'zero', name: ' p0 ' },
  { id: 'one', name: 'PHASE1' }
];

beforeEach(() => {
  jest.clearAllMocks();
  jest
    .mocked(emma.validateDistribution)
    .mockResolvedValue({ valid: true, allowlist_id: 'plan' });
  jest.mocked(emma.fetchPhaseResults).mockResolvedValue([]);
  jest.mocked(preparation.prepareDistributionPhase).mockResolvedValue({
    phase: 'Phase 0',
    airdrops: [],
    airdrops_unconsolidated: [],
    allowlists: []
  });
});

it('captures mixed phase aliases in phase order, including empty phases', async () => {
  jest.mocked(emma.fetchDistributionPhases).mockResolvedValue(phases);
  const result = await processStep(job, 'auth', {});
  expect(result.inputs).toEqual({
    zero: { name: ' p0 ', rows: [] },
    one: { name: 'PHASE1', rows: [] },
    two: { name: '2', rows: [] }
  });
  expect(preparation.prepareDistributionPhase).toHaveBeenCalledWith(
    'contract',
    1,
    'plan',
    'zero',
    'auth',
    {},
    { name: ' p0 ', rows: [] }
  );
});

it.each([
  { name: 'missing', plan: phases.slice(1), message: 'Missing Phase 2' },
  {
    name: 'duplicate',
    plan: [...phases, { id: 'duplicate', name: '1' }],
    message: 'Multiple phases match Phase 1'
  }
])(
  'rejects a $name phase before retrieving results or preparing a phase',
  async ({ plan, message }) => {
    jest.mocked(emma.fetchDistributionPhases).mockResolvedValue(plan);
    await expect(processStep(job, 'auth', {})).rejects.toThrow(message);
    expect(emma.fetchPhaseResults).not.toHaveBeenCalled();
    expect(preparation.prepareDistributionPhase).not.toHaveBeenCalled();
  }
);
