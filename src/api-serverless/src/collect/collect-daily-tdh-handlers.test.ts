import * as Operations from '@/api/generated/routes/operations';
import {
  collectDailyTdhSchema,
  handleCreateCollectDailyTdhPlan
} from '@/api/collect/collect-daily-tdh.handlers';
import { createCollectDailyTdhPlan } from '@/api/collect/collect-daily-tdh.service';

jest.mock('@/api/marketplace/marketplace.http', () => ({
  executeMarketRequest: (
    _req: unknown,
    work: (auth: unknown) => Promise<unknown>
  ) => work({})
}));
jest.mock('@/api/marketplace/marketplace.service', () => ({
  assertMarketActor: () => ({ profileId: 'profile' })
}));
jest.mock('@/api/collect/collect-daily-tdh.service', () => ({
  createCollectDailyTdhPlan: jest.fn().mockResolvedValue({ plan_id: 'plan' })
}));

const recipient = '0x1111111111111111111111111111111111111111';

beforeEach(() => jest.clearAllMocks());

it('normalizes the base-rate target request and default families', async () => {
  await handleCreateCollectDailyTdhPlan({
    body: {
      profile_id: 'profile',
      recipient,
      mode: 'BASE_TDH_TARGET',
      target_base_tdh_per_day_hundredths: '9007199254740991'
    }
  } as Operations.CreateCollectDailyTdhPlanRequest);

  expect(createCollectDailyTdhPlan).toHaveBeenCalledWith({
    profile_id: 'profile',
    recipient,
    mode: 'BASE_TDH_TARGET',
    target_base_tdh_per_day_hundredths: '9007199254740991',
    families: ['gradients', 'memes', 'pebbles']
  });
});

it('accepts a zero budget and sorts distinct requested families', async () => {
  await handleCreateCollectDailyTdhPlan({
    body: {
      profile_id: 'profile',
      recipient,
      mode: 'ETH_BUDGET',
      budget_wei: '0',
      families: ['pebbles', 'memes']
    }
  } as Operations.CreateCollectDailyTdhPlanRequest);

  expect(createCollectDailyTdhPlan).toHaveBeenCalledWith({
    profile_id: 'profile',
    recipient,
    mode: 'ETH_BUDGET',
    budget_wei: '0',
    families: ['memes', 'pebbles']
  });
});

it.each([
  {
    profile_id: 'other',
    mode: 'BASE_TDH_TARGET',
    target_base_tdh_per_day_hundredths: '1'
  },
  { mode: 'BASE_TDH_TARGET' },
  {
    mode: 'BASE_TDH_TARGET',
    target_base_tdh_per_day_hundredths: '1',
    budget_wei: '1'
  },
  { mode: 'BASE_TDH_TARGET', budget_wei: '1' },
  { mode: 'ETH_BUDGET' },
  {
    mode: 'ETH_BUDGET',
    budget_wei: '1',
    target_base_tdh_per_day_hundredths: '1'
  },
  { mode: 'ETH_BUDGET', target_base_tdh_per_day_hundredths: '1' },
  {
    mode: 'BASE_TDH_TARGET',
    target_base_tdh_per_day_hundredths: '9007199254740992'
  },
  {
    mode: 'BASE_TDH_TARGET',
    target_base_tdh_per_day_hundredths: '01'
  },
  {
    mode: 'BASE_TDH_TARGET',
    target_base_tdh_per_day_hundredths: '-1'
  },
  { mode: 'ETH_BUDGET', budget_wei: '-1' },
  {
    mode: 'ETH_BUDGET',
    budget_wei:
      '115792089237316195423570985008687907853269984665640564039457584007913129639936'
  },
  {
    mode: 'BASE_TDH_TARGET',
    target_base_tdh_per_day_hundredths: '1',
    families: []
  },
  {
    mode: 'BASE_TDH_TARGET',
    target_base_tdh_per_day_hundredths: '1',
    families: ['memes', 'memes']
  },
  {
    mode: 'BASE_TDH_TARGET',
    target_base_tdh_per_day_hundredths: '1',
    families: ['other']
  },
  {
    mode: 'BASE_TDH_TARGET',
    target_base_tdh_per_day_hundredths: '1',
    recipient: 'bad'
  },
  {
    mode: 'BASE_TDH_TARGET',
    target_base_tdh_per_day_hundredths: '1',
    recipient: '0x0000000000000000000000000000000000000000'
  },
  {
    mode: 'BASE_TDH_TARGET',
    target_base_tdh_per_day_hundredths: '1',
    extra: true
  }
])(
  'rejects invalid or cross-profile input before planning: %j',
  async (body) => {
    await expect(
      handleCreateCollectDailyTdhPlan({
        body: { profile_id: 'profile', recipient, ...body }
      } as Operations.CreateCollectDailyTdhPlanRequest)
    ).rejects.toThrow();
    expect(createCollectDailyTdhPlan).not.toHaveBeenCalled();
  }
);

it('accepts the largest canonical target through the exported schema', () => {
  expect(
    collectDailyTdhSchema.parse({
      profile_id: 'profile',
      recipient,
      mode: 'BASE_TDH_TARGET',
      target_base_tdh_per_day_hundredths: '9007199254740991'
    })
  ).toMatchObject({
    target_base_tdh_per_day_hundredths: '9007199254740991'
  });
});
