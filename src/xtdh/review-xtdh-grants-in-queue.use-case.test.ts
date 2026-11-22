const mockIsXTdhEnabled = jest.fn();
const mockIsIdentityFrozen = jest.fn();

jest.mock('@/app-features', () => ({
  appFeatures: {
    isXTdhEnabled: mockIsXTdhEnabled,
    isIdentityFrozen: mockIsIdentityFrozen
  }
}));

import { ReviewXTdhGrantsInQueueUseCase } from './review-xtdh-grants-in-queue.use-case';

describe('ReviewXTdhGrantsInQueueUseCase during the identity freeze', () => {
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

  it('reviews no pending grant while frozen', async () => {
    mockIsIdentityFrozen.mockReturnValue(true);
    const { repository, useCase } = makeUseCase();
    await useCase.handle({});
    expect(repository.executeNativeQueriesInTransaction).not.toHaveBeenCalled();
  });

  it('looks for pending grants while not frozen', async () => {
    mockIsIdentityFrozen.mockReturnValue(false);
    const { repository, useCase } = makeUseCase();
    await useCase.handle({});
    expect(repository.executeNativeQueriesInTransaction).toHaveBeenCalledTimes(
      1
    );
  });
});
