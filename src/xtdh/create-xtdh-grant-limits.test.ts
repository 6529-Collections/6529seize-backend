import { CustomApiCompliantException } from '@/exceptions';
import { CreateXTdhGrantUseCase } from './create-xtdh-grant.use-case';
import { XTdhGrantLimits } from './xtdh-grant-limits';

const command = (target_tokens: string[]) => ({
  target_chain: 1,
  target_contract: '0x0000000000000000000000000000000000000001',
  target_tokens,
  valid_to: null,
  rate: 1,
  is_irrevocable: false,
  grantor_id: 'grantor'
});

function useCase(pending: number, limits: XTdhGrantLimits) {
  const repository = {
    executeNativeQueriesInTransaction: jest.fn(
      async (run: (connection: unknown) => Promise<unknown>) => run({})
    ),
    countPendingGrantsByGrantor: jest.fn().mockResolvedValue(pending),
    insertGrant: jest.fn(),
    getGrantsTokenCounts: jest.fn().mockResolvedValue({}),
    getCollectionNames: jest.fn().mockResolvedValue({})
  };
  const indexing = {
    upsertOrSelectCollection: jest
      .fn()
      .mockResolvedValue({ status: 'LIVE_TAILING' })
  };
  return {
    repository,
    indexing,
    useCase: new CreateXTdhGrantUseCase(
      repository as never,
      indexing as never,
      () => limits
    )
  };
}

const limits = { maxTokens: 10, maxRangeWidth: 5, maxPendingGrants: 2 };

describe('CreateXTdhGrantUseCase limits', () => {
  it('rejects an oversized range before opening a transaction or expanding it', async () => {
    const { useCase: subject, repository } = useCase(0, limits);

    await expect(subject.handle(command(['0-9999999999']), {})).rejects.toThrow(
      'a range can cover at most 5'
    );

    // Ranges are expanded inside the transaction, which never opened.
    expect(repository.executeNativeQueriesInTransaction).not.toHaveBeenCalled();
    expect(repository.countPendingGrantsByGrantor).not.toHaveBeenCalled();
  });

  it('rejects a grantor at the pending grant limit with 409', async () => {
    const { useCase: subject, repository } = useCase(2, limits);

    const error = await subject
      .handle(command(['1-3']), {})
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CustomApiCompliantException);
    expect((error as CustomApiCompliantException).getStatusCode()).toBe(409);
    expect((error as CustomApiCompliantException).code).toBe(
      'PENDING_GRANT_LIMIT'
    );
    expect(repository.countPendingGrantsByGrantor).toHaveBeenCalledWith(
      'grantor',
      expect.anything()
    );
    expect(repository.insertGrant).not.toHaveBeenCalled();
  });

  it('creates a grant within the limits with its tokens expanded', async () => {
    const { useCase: subject, repository } = useCase(1, limits);

    await subject.handle(command(['1-3', '7']), {});

    const tokens = repository.insertGrant.mock.calls[0][1] as {
      token_id: string;
    }[];
    expect(tokens.map((token) => token.token_id)).toEqual(['1', '2', '3', '7']);
  });
});
