import * as Operations from '@/api/generated/routes/operations';
import {
  collectTdhTargetSchema,
  handleCreateCollectTdhTargetPlan
} from '@/api/collect/collect-tdh-target.handlers';
import { createCollectTdhTargetPlan } from '@/api/collect/collect-tdh-target.service';
jest.mock('@/api/marketplace/marketplace.http', () => ({
  executeMarketRequest: (
    _req: unknown,
    work: (auth: unknown) => Promise<unknown>
  ) => work({})
}));
jest.mock('@/api/marketplace/marketplace.service', () => ({
  assertMarketActor: () => ({ profileId: 'profile' })
}));
jest.mock('@/api/collect/collect-tdh-target.service', () => ({
  createCollectTdhTargetPlan: jest.fn().mockResolvedValue({ plan_id: 'plan' })
}));
const body = {
  profile_id: 'profile',
  recipient: '0x1111111111111111111111111111111111111111',
  target_tdh: '0',
  horizon_days: 30
};
beforeEach(() => jest.clearAllMocks());
it('normalizes explicit semantics and preserves zero without a spending ceiling', async () => {
  await handleCreateCollectTdhTargetPlan({
    body
  } as Operations.CreateCollectTdhTargetPlanRequest);
  expect(createCollectTdhTargetPlan).toHaveBeenCalledWith({
    ...body,
    target_mode: 'TOTAL_AT_DEADLINE',
    families: ['gradients', 'memes', 'pebbles']
  });
});
it.each([
  { profile_id: 'other' },
  { target_tdh: '1.5' },
  { target_tdh: '-1' },
  { target_tdh: '01' },
  { target_tdh: '9007199254740992' },
  { horizon_days: 2 },
  { families: [] },
  { families: ['memes', 'memes'] },
  { families: ['other'] },
  { budget_wei: '-1' },
  {
    budget_wei:
      '115792089237316195423570985008687907853269984665640564039457584007913129639936'
  },
  { target_mode: 'TOTAL' },
  { price_wei: '1' },
  { recipient: 'bad' }
])(
  'rejects invalid or cross-profile input before discovery: %j',
  async (extra) => {
    await expect(
      handleCreateCollectTdhTargetPlan({
        body: { ...body, ...extra }
      } as Operations.CreateCollectTdhTargetPlanRequest)
    ).rejects.toThrow();
    expect(createCollectTdhTargetPlan).not.toHaveBeenCalled();
  }
);
it.each([1, 30, 90, 365])(
  'supports exactly the existing horizon %i',
  (horizon_days) => {
    expect(
      collectTdhTargetSchema.parse({
        ...body,
        horizon_days,
        target_mode: 'ADDITIONAL_OVER_BASELINE',
        target_tdh: '9007199254740991',
        budget_wei: '0'
      })
    ).toMatchObject({ horizon_days, budget_wei: '0' });
  }
);
