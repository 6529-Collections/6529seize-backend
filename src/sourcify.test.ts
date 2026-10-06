import { getSourcifyContractName } from '@/sourcify';

jest.mock('@/logging', () => ({
  Logger: { get: () => ({ warn: jest.fn() }) }
}));

const address = '0x00000000219ab540356cBB839Cbe05303d7705Fa';
const originalFetch = global.fetch;

describe('Sourcify contract names', () => {
  let fetchMock: jest.MockedFunction<typeof fetch>;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.useRealTimers();
  });

  it.each([1, 11155111, 5])(
    'looks up a verified name on chain %s without a key',
    async (chainId) => {
      fetchMock.mockResolvedValue(
        new Response(
          JSON.stringify({ compilation: { name: ' DepositContract ' } })
        )
      );
      await expect(getSourcifyContractName(chainId, address)).resolves.toBe(
        'DepositContract'
      );
      expect(fetchMock).toHaveBeenCalledWith(
        `https://sourcify.dev/server/v2/contract/${chainId}/${address}?fields=compilation.name`,
        { signal: expect.any(AbortSignal) }
      );
    }
  );

  it.each([
    null,
    {},
    { compilation: null },
    { compilation: {} },
    { compilation: { name: 42 } },
    { compilation: { name: ' ' } }
  ])('returns no name for incomplete metadata: %j', async (data) => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(data)));
    await expect(getSourcifyContractName(1, address)).resolves.toBeNull();
  });

  it.each([404, 429, 500])('returns no name on HTTP %s', async (status) => {
    fetchMock.mockResolvedValue(new Response('', { status }));
    await expect(getSourcifyContractName(1, address)).resolves.toBeNull();
  });

  it('returns no name on a network error', async () => {
    fetchMock.mockRejectedValue(new Error('connection failed'));
    await expect(getSourcifyContractName(1, address)).resolves.toBeNull();
  });

  it('returns no name on invalid JSON', async () => {
    fetchMock.mockResolvedValue(new Response('invalid JSON'));
    await expect(getSourcifyContractName(1, address)).resolves.toBeNull();
  });

  it('aborts a stalled lookup after five seconds and clears its timer', async () => {
    jest.useFakeTimers();
    fetchMock.mockImplementation(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options!.signal!.addEventListener('abort', () =>
            reject(new Error('aborted'))
          );
        })
    );
    const lookup = getSourcifyContractName(1, address);
    await jest.advanceTimersByTimeAsync(5000);
    await expect(lookup).resolves.toBeNull();
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each([
    [0, address],
    [1.5, address],
    [1, 'invalid-address']
  ])('skips invalid lookup parameters', async (chainId, contract) => {
    await expect(
      getSourcifyContractName(Number(chainId), String(contract))
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
