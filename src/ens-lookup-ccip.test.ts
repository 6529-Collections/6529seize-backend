import { Interface, JsonRpcProvider, makeError } from 'ethers';
import { lookupPrimaryEnsName } from '@/ens-lookup';
import { getRpcProvider } from '@/rpc-provider';

jest.mock('@/rpc-provider', () => ({ getRpcProvider: jest.fn() }));
jest.mock('@/logging', () => ({
  Logger: { get: () => ({ info: jest.fn(), debug: jest.fn() }) }
}));

const resolver = '0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe';
const wallet = '0x1111111111111111111111111111111111111111';
const abi = new Interface([
  'function reverse(bytes lookupAddress, uint256 coinType) view returns (string primary, address resolver, address reverseResolver)',
  'function reverseCallback(bytes response, bytes extraData) view returns (string primary, address resolver, address reverseResolver)',
  'error OffchainLookup(address sender, string[] urls, bytes callData, bytes4 callbackFunction, bytes extraData)'
]);

it('completes the ethers off-chain lookup and callback on the same provider', async () => {
  const provider = new JsonRpcProvider('https://rpc.example.test', 1, {
    staticNetwork: true
  });
  jest.mocked(getRpcProvider).mockReturnValue(provider);
  jest.spyOn(provider, 'lookupAddress').mockResolvedValue(null);
  const fetch = jest
    .spyOn(provider, 'ccipReadFetch')
    .mockResolvedValue('0x1234');
  const calls = jest
    .spyOn(provider, '_perform')
    .mockImplementation(async (req) => {
      if (req.method !== 'call')
        throw new Error('Unexpected provider operation');
      const tx = req.transaction;
      if (tx.data?.startsWith(abi.getFunction('reverse')!.selector)) {
        throw makeError('OffchainLookup', 'CALL_EXCEPTION', {
          action: 'call',
          transaction: { to: resolver, data: tx.data },
          data: abi.encodeErrorResult('OffchainLookup', [
            resolver,
            ['https://gateway.example.test/{data}'],
            '0xabcd',
            abi.getFunction('reverseCallback')!.selector,
            '0xbeef'
          ]),
          reason: null,
          invocation: null,
          revert: null
        });
      }
      expect(tx.to?.toLowerCase()).toBe(resolver.toLowerCase());
      expect(tx.data).toBe(
        abi.encodeFunctionData('reverseCallback', ['0x1234', '0xbeef'])
      );
      return abi.encodeFunctionResult('reverse', [
        'offchain.eth',
        resolver,
        resolver
      ]);
    });

  try {
    await expect(lookupPrimaryEnsName(wallet)).resolves.toBe('offchain.eth');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(calls).toHaveBeenCalledTimes(2);
  } finally {
    provider.destroy();
  }
});
