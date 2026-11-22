const mockIsXTdhEnabled = jest.fn();
const mockIsIdentityFrozen = jest.fn();

jest.mock('@/app-features', () => ({
  appFeatures: {
    isXTdhEnabled: mockIsXTdhEnabled,
    isIdentityFrozen: mockIsIdentityFrozen
  }
}));

import { ReviewXTdhGrantsInQueueUseCase } from './review-xtdh-grants-in-queue.use-case';

describe('ReviewXTdhGrantsInQueueUseCase and the xTDH retirement', () => {
  function makeUseCase() {
    const repository = {
      executeNativeQueriesInTransaction: jest.fn().mockResolvedValue(false)
    };
    const useCase = new ReviewXTdhGrantsInQueueUseCase(
      repository as any,
      {} as any,
      {} as any
    );
    return { repository, useCase };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.IDENTITY_FREEZE_AT;
    mockIsXTdhEnabled.mockReturnValue(true);
  });

  it('reviews no pending grant once xTDH is retired', async () => {
    mockIsIdentityFrozen.mockReturnValue(true);
    const { repository, useCase } = makeUseCase();
    await useCase.handle({});
    expect(repository.executeNativeQueriesInTransaction).not.toHaveBeenCalled();
  });

  it('looks for pending grants before the retirement', async () => {
    mockIsIdentityFrozen.mockReturnValue(false);
    const { repository, useCase } = makeUseCase();
    await useCase.handle({});
    expect(repository.executeNativeQueriesInTransaction).toHaveBeenCalledTimes(
      1
    );
  });
});
