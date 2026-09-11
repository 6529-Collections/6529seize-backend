import { FetchRequest, Interface, JsonRpcProvider, makeError } from 'ethers';
import { getRpcProvider } from '@/rpc-provider';
import {
  createWalletGalleryEnsProvider,
  resolveWalletGalleryEns
} from '@/profile-cms/wallet-gallery/wallet-gallery-ens-resolver';

const ADDRESS = '0xfD22004806A6846EA67ad883356be810F0428793';

describe('CMS onchain ENS resolver', () => {
  const originalKey = process.env.ALCHEMY_API_KEY;
  beforeEach(() => {
    process.env.ALCHEMY_API_KEY = 'configured-test-key';
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    if (originalKey === undefined) delete process.env.ALCHEMY_API_KEY;
    else process.env.ALCHEMY_API_KEY = originalKey;
  });

  it('uses only the configured mainnet RPC with bounded transport and leaves shared providers unchanged', () => {
    const shared = getRpcProvider();
    const previousCcipSetting = shared.disableCcipRead;
    const previousTimeout = shared._getConnection().timeout;
    const provider = createWalletGalleryEnsProvider();
    try {
      expect(provider).not.toBe(shared);
      expect(provider.disableCcipRead).toBe(true);
      expect(provider._getConnection().url).toBe(
        'https://eth-mainnet.g.alchemy.com/v2/configured-test-key'
      );
      expect(provider._getConnection().timeout).toBe(1500);
      expect(shared.disableCcipRead).toBe(previousCcipSetting);
      expect(shared._getConnection().timeout).toBe(previousTimeout);
    } finally {
      provider.destroy();
    }
  });

  it('rejects an OffchainLookup response without fetching its resolver-supplied URL', async () => {
    const provider = createWalletGalleryEnsProvider();
    const errors = new Interface([
      'error OffchainLookup(address sender, string[] urls, bytes callData, bytes4 callbackFunction, bytes extraData)'
    ]);
    const data = errors.encodeErrorResult('OffchainLookup', [
      ADDRESS,
      ['https://example.test/{data}'],
      '0x1234',
      '0x12345678',
      '0x'
    ]);
    const transaction = { to: ADDRESS, data: '0x1234' };
    jest.spyOn(provider, '_perform').mockRejectedValue(
      makeError('execution reverted', 'CALL_EXCEPTION', {
        action: 'call',
        data,
        reason: 'OffchainLookup',
        transaction,
        invocation: null,
        revert: null
      })
    );
    const offchainFetch = jest.spyOn(provider, 'ccipReadFetch');
    const httpSend = jest
      .spyOn(FetchRequest.prototype, 'send')
      .mockRejectedValue(new Error('Unexpected network request'));
    try {
      await expect(
        provider.call({ ...transaction, enableCcipRead: true })
      ).rejects.toMatchObject({
        code: 'CALL_EXCEPTION',
        data
      });
      expect(offchainFetch).not.toHaveBeenCalled();
      await expect(
        provider.ccipReadFetch(transaction, '0x1234', [
          'https://example.test/{data}'
        ])
      ).resolves.toBeNull();
      expect(httpSend).not.toHaveBeenCalled();
    } finally {
      provider.destroy();
    }
  });

  it('caches successful onchain results for one minute and disposes its provider', async () => {
    const resolveName = jest
      .spyOn(JsonRpcProvider.prototype, 'resolveName')
      .mockImplementation(async function (this: JsonRpcProvider) {
        expect(this.disableCcipRead).toBe(true);
        return ADDRESS;
      });
    const destroy = jest.spyOn(JsonRpcProvider.prototype, 'destroy');
    await expect(resolveWalletGalleryEns('cached-alias.eth')).resolves.toBe(
      ADDRESS
    );
    await expect(resolveWalletGalleryEns('cached-alias.eth')).resolves.toBe(
      ADDRESS
    );
    expect(resolveName).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(60_001);
    await expect(resolveWalletGalleryEns('cached-alias.eth')).resolves.toBe(
      ADDRESS
    );
    expect(resolveName).toHaveBeenCalledTimes(2);
  });

  it('does not cache missing records', async () => {
    const resolveName = jest
      .spyOn(JsonRpcProvider.prototype, 'resolveName')
      .mockResolvedValue(null);
    await expect(
      resolveWalletGalleryEns('missing-record.eth')
    ).resolves.toBeNull();
    await expect(
      resolveWalletGalleryEns('missing-record.eth')
    ).resolves.toBeNull();
    expect(resolveName).toHaveBeenCalledTimes(2);
  });

  it('disposes the isolated provider after a lookup fails', async () => {
    jest
      .spyOn(JsonRpcProvider.prototype, 'resolveName')
      .mockRejectedValue(new Error('provider failed'));
    const destroy = jest.spyOn(JsonRpcProvider.prototype, 'destroy');
    await expect(resolveWalletGalleryEns('failed-record.eth')).rejects.toThrow(
      'provider failed'
    );
    expect(destroy).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('disposes a stalled resolver after its deadline', async () => {
    jest
      .spyOn(JsonRpcProvider.prototype, 'resolveName')
      .mockImplementation(() => new Promise(() => {}));
    const destroy = jest.spyOn(JsonRpcProvider.prototype, 'destroy');
    const result = expect(
      resolveWalletGalleryEns('stalled-record.eth')
    ).rejects.toThrow('timed out');
    await jest.advanceTimersByTimeAsync(4000);
    await result;
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('requires configured credentials before creating a provider', () => {
    delete process.env.ALCHEMY_API_KEY;
    expect(createWalletGalleryEnsProvider).toThrow('not configured');
  });
});
