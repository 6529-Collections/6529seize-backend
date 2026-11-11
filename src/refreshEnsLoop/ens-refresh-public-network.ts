import { promises as dns } from 'node:dns';
import type { LookupOptions } from 'node:dns';
import { BlockList, isIP, LookupFunction } from 'node:net';
import { isPrivateIp, parseAndValidatePublicHttpUrl } from '@/http/safe-fetch';

const nonPublicIpv6 = new BlockList();
nonPublicIpv6.addAddress('::', 'ipv6');
nonPublicIpv6.addAddress('::1', 'ipv6');
nonPublicIpv6.addSubnet('fc00::', 7, 'ipv6');
nonPublicIpv6.addSubnet('fe80::', 9, 'ipv6');
nonPublicIpv6.addSubnet('ff00::', 8, 'ipv6');

function isPublicAddress(address: string): boolean {
  return (
    !isPrivateIp(address) &&
    !(isIP(address) === 6 && nonPublicIpv6.check(address, 'ipv6'))
  );
}

export function assertPublicEnsUrl(value: string): void {
  const url = parseAndValidatePublicHttpUrl(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(hostname) && !isPublicAddress(hostname)) {
    throw new Error('ENS gateway requires a public address');
  }
}

function requestedAddressFamily(family: LookupOptions['family']): number {
  if (family === 4 || family === 'IPv4') return 4;
  if (family === 6 || family === 'IPv6') return 6;
  return 0;
}

/** Validate the very DNS answers used by connect, without a second lookup. */
export const publicEnsLookup: LookupFunction = (
  hostname,
  options,
  callback
) => {
  void dns.lookup(hostname, { ...options, all: true }).then(
    (addresses) => {
      const family = requestedAddressFamily(options.family);
      const matching = family
        ? addresses.filter((entry) => entry.family === family)
        : addresses;
      if (
        !matching.length ||
        addresses.some(({ address }) => !isPublicAddress(address))
      ) {
        callback(new Error('ENS gateway requires public DNS answers'), []);
      } else if (options.all) {
        callback(null, matching);
      } else {
        callback(null, matching[0].address, matching[0].family);
      }
    },
    () => callback(new Error('ENS gateway DNS unavailable'), [])
  );
};
