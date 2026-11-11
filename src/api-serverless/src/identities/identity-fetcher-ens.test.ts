import { Interface } from 'ethers';
import { NotFoundException } from '@/exceptions';
import { IdentityFetcher } from './identity.fetcher';

const resolverInterface = new Interface([
  'function requireResolver(bytes) view returns (address)',
  'error ResolverNotFound(bytes name)',
  'error ResolverNotContract(bytes name, address resolver)'
]);
const wallet = '0x0000000000000000000000000000000000000001';

function resolverError(name: string, args: readonly unknown[]) {
  return resolverInterface.makeError(
    resolverInterface.encodeErrorResult(name, args),
    {
      to: wallet,
      data: resolverInterface.encodeFunctionData('requireResolver', ['0x'])
    }
  );
}

describe('IdentityFetcher ENS resolution', () => {
  const resolveName = jest.fn();
  const getIdentityByWallet = jest.fn();
  const fetcher = new IdentityFetcher(
    { getIdentityByWallet } as never,
    {} as never,
    {} as never,
    {} as never,
    () => ({ resolveName })
  );
  const lookup = () =>
    fetcher.getIdentityAndConsolidationsByIdentityKey(
      { identityKey: 'Missing.eth' },
      {}
    );

  beforeEach(() => {
    resolveName.mockReset();
    getIdentityByWallet.mockReset().mockResolvedValue(null);
  });

  it('returns no identity for the Universal Resolver missing-resolver revert', async () => {
    resolveName.mockRejectedValue(resolverError('ResolverNotFound', ['0x']));

    await expect(lookup()).resolves.toBeNull();
    expect(resolveName).toHaveBeenCalledTimes(1);
    expect(resolveName).toHaveBeenCalledWith('missing.eth');
    expect(getIdentityByWallet).not.toHaveBeenCalled();
    await expect(
      fetcher.getProfileIdByIdentityKey({ identityKey: 'missing.eth' }, {})
    ).resolves.toBeNull();
    await expect(
      fetcher.getProfileIdByIdentityKeyOrThrow(
        { identityKey: 'missing.eth' },
        {}
      )
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('preserves a provider null result', async () => {
    resolveName.mockResolvedValue(null);
    await expect(lookup()).resolves.toBeNull();
    expect(getIdentityByWallet).not.toHaveBeenCalled();
  });

  it('recognizes the structured custom-error signature without a reason string', async () => {
    const error = Object.assign(resolverError('ResolverNotFound', ['0x']), {
      reason: null
    });
    resolveName.mockRejectedValue(error);
    await expect(lookup()).resolves.toBeNull();
    expect(getIdentityByWallet).not.toHaveBeenCalled();
  });

  it('resolves an unregistered wallet once and preserves the ENS query on its synthetic identity', async () => {
    resolveName.mockResolvedValue(wallet);
    await expect(lookup()).resolves.toMatchObject({
      primary_wallet: wallet,
      query: 'missing.eth'
    });
    expect(getIdentityByWallet).toHaveBeenCalledWith(wallet, undefined);
    expect(getIdentityByWallet).toHaveBeenCalledTimes(1);
  });

  it.each([
    Object.assign(new Error('RPC timed out'), { code: 'TIMEOUT' }),
    Object.assign(new Error('RPC unavailable'), { code: 'SERVER_ERROR' }),
    resolverError('ResolverNotContract', ['0x', wallet]),
    Object.assign(new Error('execution reverted'), {
      code: 'CALL_EXCEPTION',
      reason: null
    }),
    new Error('execution reverted: ResolverNotFound(bytes)')
  ])('propagates other resolution errors (%s)', async (error) => {
    resolveName.mockRejectedValue(error);
    await expect(lookup()).rejects.toBe(error);
    expect(getIdentityByWallet).not.toHaveBeenCalled();
  });

  it('does not turn downstream failures into a missing identity', async () => {
    const error = resolverError('ResolverNotFound', ['0x']);
    resolveName.mockResolvedValue(wallet);
    getIdentityByWallet.mockRejectedValue(error);
    await expect(lookup()).rejects.toBe(error);
  });
});
