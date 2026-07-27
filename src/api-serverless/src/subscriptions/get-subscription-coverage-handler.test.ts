const mockCalculateCoverage = jest.fn();
const mockMapSubscriptionCoverageToApi = jest.fn();
const mockGetFromRequest = jest.fn();

jest.mock(
  '@/subscription-coverage/subscription-coverage-reconciliation.service',
  () => ({
    subscriptionCoverageReconciliationService: {
      calculateCoverage: mockCalculateCoverage
    }
  })
);

jest.mock('./subscription-coverage.api-mapper', () => ({
  mapSubscriptionCoverageToApi: mockMapSubscriptionCoverageToApi
}));

jest.mock('@/time', () => ({
  Timer: { getFromRequest: mockGetFromRequest }
}));

import { GetSubscriptionCoverageRequest } from '@/api/generated/routes/operations';
import { handleGetSubscriptionCoverage } from './get-subscription-coverage.handler';

function requestWithConsolidationKey(
  consolidationKey: string
): GetSubscriptionCoverageRequest {
  return {
    params: { consolidation_key: consolidationKey }
  } as GetSubscriptionCoverageRequest;
}

describe('handleGetSubscriptionCoverage', () => {
  const timer = { marker: 'timer' };
  const forecast = { marker: 'forecast' };
  const response = { marker: 'response' };

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetFromRequest.mockReturnValue(timer);
    mockCalculateCoverage.mockResolvedValue(forecast);
    mockMapSubscriptionCoverageToApi.mockReturnValue(response);
  });

  it('normalizes the consolidation key and returns the generated response', async () => {
    const req = requestWithConsolidationKey('  0xAbC  ');

    await expect(handleGetSubscriptionCoverage(req)).resolves.toBe(response);

    expect(mockCalculateCoverage).toHaveBeenCalledWith('0xabc', { timer });
    expect(mockMapSubscriptionCoverageToApi).toHaveBeenCalledWith(forecast);
  });

  it('rejects an empty consolidation key before calculating coverage', async () => {
    const req = requestWithConsolidationKey('   ');

    await expect(handleGetSubscriptionCoverage(req)).rejects.toThrow();
    expect(mockCalculateCoverage).not.toHaveBeenCalled();
  });
});
