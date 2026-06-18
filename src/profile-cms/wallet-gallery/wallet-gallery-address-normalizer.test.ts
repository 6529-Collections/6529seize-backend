import * as fc from 'fast-check';
import {
  normalizeEnsName,
  normalizeEthereumAddress,
  WalletGalleryAddressNormalizer
} from '@/profile-cms/wallet-gallery/wallet-gallery-address-normalizer';

describe('WalletGalleryAddressNormalizer', () => {
  it('normalizes lowercase Ethereum addresses', () => {
    const hex = fc.constantFrom(
      '0',
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
      'a',
      'b',
      'c',
      'd',
      'e',
      'f'
    );

    fc.assert(
      fc.property(
        fc.stringOf(hex, { minLength: 40, maxLength: 40 }),
        (body) => {
          const address = `0x${body}`;
          expect(normalizeEthereumAddress(address)).toBe(address);
        }
      ),
      { numRuns: 25 }
    );
  });

  it('normalizes supported ENS names without using live resolution', () => {
    expect(normalizeEnsName(' Punk6529Bot.ETH. ')).toBe('punk6529bot.eth');
    expect(normalizeEnsName('not an ens')).toBeNull();
    expect(
      normalizeEnsName('0x1111111111111111111111111111111111111111')
    ).toBeNull();
  });

  it('resolves wallet and ENS inputs from the indexed ENS table', async () => {
    const execute = jest.fn().mockResolvedValue([
      {
        wallet: '0x1111111111111111111111111111111111111111',
        display: 'alpha.eth'
      },
      {
        wallet: '0x2222222222222222222222222222222222222222',
        display: 'Beta.eth'
      }
    ]);
    const normalizer = new WalletGalleryAddressNormalizer(
      () => ({ execute }) as any
    );

    const result = await normalizer.normalizeWalletInputs(
      [
        ' 0x1111111111111111111111111111111111111111 ',
        'beta.eth',
        'missing.eth',
        'not a wallet'
      ],
      {}
    );

    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('FROM ens'),
      {
        addresses: ['0x1111111111111111111111111111111111111111'],
        ensNames: ['beta.eth', 'missing.eth']
      },
      undefined
    );
    expect(result).toEqual({
      inputs: [
        {
          input: '0x1111111111111111111111111111111111111111',
          address: '0x1111111111111111111111111111111111111111',
          ens: 'alpha.eth',
          display: 'alpha.eth',
          status: 'resolved',
          reason: null
        },
        {
          input: 'beta.eth',
          address: '0x2222222222222222222222222222222222222222',
          ens: 'beta.eth',
          display: 'Beta.eth',
          status: 'resolved',
          reason: null
        },
        {
          input: 'missing.eth',
          address: null,
          ens: 'missing.eth',
          display: 'missing.eth',
          status: 'unresolved',
          reason: 'ens_not_found'
        },
        {
          input: 'not a wallet',
          address: null,
          ens: null,
          display: null,
          status: 'unresolved',
          reason: 'invalid_format'
        }
      ],
      addresses: [
        '0x1111111111111111111111111111111111111111',
        '0x2222222222222222222222222222222222222222'
      ]
    });
  });

  it('dedupes resolved addresses while preserving input results', async () => {
    const execute = jest.fn().mockResolvedValue([]);
    const normalizer = new WalletGalleryAddressNormalizer(
      () => ({ execute }) as any
    );

    const result = await normalizer.normalizeWalletInputs(
      [
        '0x1111111111111111111111111111111111111111',
        '0x1111111111111111111111111111111111111111'
      ],
      {}
    );

    expect(result.inputs).toHaveLength(2);
    expect(result.addresses).toEqual([
      '0x1111111111111111111111111111111111111111'
    ]);
  });
});
