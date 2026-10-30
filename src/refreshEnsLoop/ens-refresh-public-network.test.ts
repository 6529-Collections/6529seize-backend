import { promises as dns } from 'node:dns';
import type { LookupAddress } from 'node:dns';
import {
  assertPublicEnsUrl,
  publicEnsLookup
} from './ens-refresh-public-network';

jest.mock('node:dns', () => ({ promises: { lookup: jest.fn() } }));
beforeEach(() => jest.resetAllMocks());

// Select the all-addresses overload used by the production connection lookup.
const lookupAll = dns.lookup as (
  hostname: string,
  options: { all: true }
) => Promise<LookupAddress[]>;

function lookup(all = true, family?: number) {
  return new Promise<{
    address: string | import('node:dns').LookupAddress[];
    family?: number;
  }>((resolve, reject) => {
    publicEnsLookup(
      'gateway.test',
      family ? { all, family } : { all },
      (error, address, family) => {
        if (error) reject(error);
        else resolve({ address, family });
      }
    );
  });
}

it.each([
  'http://127.0.0.1',
  'http://10.0.0.1',
  'http://172.16.0.1',
  'http://192.168.0.1',
  'http://169.254.169.254',
  'http://localhost',
  'http://[::1]',
  'http://[::ffff:127.0.0.1]',
  'http://[fe90::1]',
  'http://[fd00:ec2::254]',
  'https://user:password@gateway.test'
])('rejects a non-public or credentialed gateway %s', (url) => {
  expect(() => assertPublicEnsUrl(url)).toThrow();
});

it.each([
  'https://gateway.test/path',
  'https://1.1.1.1',
  'https://[2606:4700:4700::1111]'
])('accepts a public gateway %s', (url) => {
  expect(() => assertPublicEnsUrl(url)).not.toThrow();
});

it.each([
  '127.0.0.1',
  '10.0.0.1',
  '169.254.169.254',
  'fe90::1',
  '0:0:0:0:0:0:0:1',
  'fec0::1',
  '::ffff:7f00:1'
])(
  'rejects private DNS answer %s even alongside public answers',
  async (address) => {
    jest.mocked(lookupAll).mockResolvedValue([
      { address: '1.1.1.1', family: 4 },
      { address, family: address.includes(':') ? 6 : 4 }
    ]);
    await expect(lookup()).rejects.toThrow('public DNS answers');
  }
);

it.each([true, false])(
  'passes the validated DNS results directly to connect (all=%s)',
  async (all) => {
    const addresses = [{ address: '1.1.1.1', family: 4 }];
    jest.mocked(lookupAll).mockResolvedValue(addresses);
    await expect(lookup(all)).resolves.toEqual(
      all
        ? { address: addresses, family: undefined }
        : { address: '1.1.1.1', family: 4 }
    );
    expect(dns.lookup).toHaveBeenCalledTimes(1);
    expect(dns.lookup).toHaveBeenCalledWith('gateway.test', { all: true });
  }
);

it('fails closed on empty DNS results or lookup failure', async () => {
  jest
    .mocked(lookupAll)
    .mockResolvedValueOnce([])
    .mockRejectedValueOnce(new Error('synthetic failure'));
  await expect(lookup()).rejects.toThrow();
  await expect(lookup()).rejects.toThrow('DNS unavailable');
});

it.each([4, 6])(
  'honors requested address family %s in the pinned connect result',
  async (family) => {
    const ipv6 = { address: '2606:4700:4700::1111', family: 6 };
    const ipv4 = { address: '1.1.1.1', family: 4 };
    jest.mocked(lookupAll).mockResolvedValue([ipv6, ipv4]);
    await expect(lookup(false, family)).resolves.toEqual(
      family === 4 ? ipv4 : ipv6
    );
    expect(dns.lookup).toHaveBeenCalledWith('gateway.test', {
      family,
      all: true
    });
  }
);
