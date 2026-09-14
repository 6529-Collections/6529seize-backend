import * as fc from 'fast-check';
import {
  normalizeEnsName,
  normalizeEthereumAddress,
  WalletGalleryAddressNormalizer
} from '@/profile-cms/wallet-gallery/wallet-gallery-address-normalizer';
import { SqlExecutor } from '@/sql-executor';

const ALIAS_ADDRESS = '0xfD22004806A6846EA67ad883356be810F0428793';

function createNormalizer(
  resolveEns: (name: string) => Promise<string | null>,
  rows: { wallet: string; display: string | null }[] = []
) {
  const execute = jest.fn().mockResolvedValue(rows);
  return new WalletGalleryAddressNormalizer(
    () => ({ execute }) as unknown as SqlExecutor,
    resolveEns
  );
}

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

  it('uses indexed displays with verified forward ENS addresses', async () => {
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
      () => ({ execute }) as any,
      async (name) =>
        name === 'beta.eth'
          ? '0x2222222222222222222222222222222222222222'
          : null
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

  it('resolves a forward alias missing from the reverse index and deduplicates names and addresses', async () => {
    const resolveEns = jest.fn().mockResolvedValue(ALIAS_ADDRESS);
    const normalizer = createNormalizer(resolveEns, [
      { wallet: ALIAS_ADDRESS.toLowerCase(), display: 'genesis.punk6529.eth' }
    ]);

    const result = await normalizer.normalizeWalletInputs(
      [' Punk6529.ETH. ', 'punk6529.eth', ALIAS_ADDRESS],
      {}
    );

    expect(resolveEns).toHaveBeenCalledTimes(1);
    expect(resolveEns).toHaveBeenCalledWith('punk6529.eth');
    expect(result.addresses).toEqual([ALIAS_ADDRESS.toLowerCase()]);
    expect(result.inputs).toMatchObject([
      {
        address: ALIAS_ADDRESS.toLowerCase(),
        ens: 'punk6529.eth',
        display: 'punk6529.eth',
        status: 'resolved',
        reason: null
      },
      { address: ALIAS_ADDRESS.toLowerCase(), status: 'resolved' },
      { address: ALIAS_ADDRESS.toLowerCase(), display: 'genesis.punk6529.eth' }
    ]);
  });

  it('uses the current forward address instead of a stale indexed ENS owner', async () => {
    const staleAddress = '0x1111111111111111111111111111111111111111';
    const normalizer = createNormalizer(
      jest.fn().mockResolvedValue(ALIAS_ADDRESS),
      [{ wallet: staleAddress, display: 'punk6529.eth' }]
    );

    const result = await normalizer.normalizeWalletInputs(
      ['punk6529.eth', staleAddress],
      {}
    );

    expect(result.inputs[0]).toMatchObject({
      address: ALIAS_ADDRESS.toLowerCase(),
      status: 'resolved'
    });
    expect(result.inputs[1]).toMatchObject({ address: staleAddress });
    expect(result.addresses).toEqual([
      ALIAS_ADDRESS.toLowerCase(),
      staleAddress
    ]);
  });

  it.each([
    null,
    'not an address',
    '0x0000000000000000000000000000000000000000'
  ])(
    'keeps missing or invalid forward results unresolved: %s',
    async (address) => {
      const normalizer = createNormalizer(
        jest.fn().mockResolvedValue(address),
        [{ wallet: ALIAS_ADDRESS, display: 'punk6529.eth' }]
      );
      const result = await normalizer.normalizeWalletInputs(
        ['punk6529.eth'],
        {}
      );
      expect(result.addresses).toEqual([]);
      expect(result.inputs[0]).toMatchObject({
        address: null,
        status: 'unresolved',
        reason: 'ens_not_found'
      });
    }
  );

  it('reports lookup failures separately without exposing dependency errors or using stale names', async () => {
    const normalizer = createNormalizer(
      jest.fn().mockRejectedValue(new Error('private provider detail')),
      [{ wallet: ALIAS_ADDRESS, display: 'punk6529.eth' }]
    );
    const result = await normalizer.normalizeWalletInputs(
      ['punk6529.eth', ALIAS_ADDRESS],
      {}
    );
    expect(result.inputs[0]).toMatchObject({
      address: null,
      status: 'unresolved',
      reason: 'ens_lookup_failed'
    });
    expect(result.addresses).toEqual([ALIAS_ADDRESS.toLowerCase()]);
    expect(JSON.stringify(result)).not.toContain('private provider detail');
  });

  it('bounds parallel lookups and the number of distinct names per request', async () => {
    jest.useFakeTimers();
    try {
      let active = 0;
      let peak = 0;
      const resolveEns = jest.fn(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return ALIAS_ADDRESS;
      });
      const normalizer = createNormalizer(resolveEns);
      const pending = normalizer.normalizeWalletInputs(
        Array.from({ length: 27 }, (_, index) => `wallet${index}.eth`),
        {}
      );
      await jest.runAllTimersAsync();
      const result = await pending;
      expect(peak).toBe(4);
      expect(resolveEns).toHaveBeenCalledTimes(25);
      expect(
        result.inputs.filter((input) => input.status === 'resolved')
      ).toHaveLength(25);
      expect(result.inputs[25]?.reason).toBe('ens_lookup_failed');
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('returns within the overall deadline and does not start queued lookups after timeout', async () => {
    jest.useFakeTimers();
    try {
      const finish: ((address: string) => void)[] = [];
      const resolveEns = jest.fn(
        () => new Promise<string>((resolve) => finish.push(resolve))
      );
      const normalizer = createNormalizer(resolveEns);
      const pending = normalizer.normalizeWalletInputs(
        Array.from({ length: 10 }, (_, index) => `wallet${index}.eth`),
        {}
      );
      await jest.advanceTimersByTimeAsync(4000);
      const result = await pending;
      expect(resolveEns).toHaveBeenCalledTimes(4);
      expect(result.addresses).toEqual([]);
      expect(
        result.inputs.every((input) => input.reason === 'ens_lookup_failed')
      ).toBe(true);
      finish.forEach((resolve) => resolve(ALIAS_ADDRESS));
      await jest.advanceTimersByTimeAsync(0);
      expect(resolveEns).toHaveBeenCalledTimes(4);
      expect(result.addresses).toEqual([]);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not request ENS resolution for addresses or unsupported inputs', async () => {
    const resolveEns = jest.fn();
    const normalizer = createNormalizer(resolveEns);
    const result = await normalizer.normalizeWalletInputs(
      [ALIAS_ADDRESS, 'https://example.com', 'bad name.eth'],
      {}
    );
    expect(resolveEns).not.toHaveBeenCalled();
    expect(result.inputs[1]?.reason).toBe('invalid_format');
    expect(result.inputs[2]?.reason).toBe('invalid_format');
  });
});
