import { isIP } from 'node:net';

/**
 * Address classification for outbound requests that must only reach the
 * public internet. Anything that cannot be parsed is treated as non-public.
 */

type Ipv4Range = readonly [base: number, prefixLength: number];

function ipv4(a: number, b: number, c: number, d: number): number {
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

// IANA IPv4 special-purpose registry entries that are not globally reachable,
// plus multicast and the reserved/broadcast block.
const NON_PUBLIC_IPV4_RANGES: readonly Ipv4Range[] = [
  [ipv4(0, 0, 0, 0), 8],
  [ipv4(10, 0, 0, 0), 8],
  [ipv4(100, 64, 0, 0), 10],
  [ipv4(127, 0, 0, 0), 8],
  [ipv4(169, 254, 0, 0), 16],
  [ipv4(172, 16, 0, 0), 12],
  [ipv4(192, 0, 0, 0), 24],
  [ipv4(192, 0, 2, 0), 24],
  [ipv4(192, 31, 196, 0), 24],
  [ipv4(192, 52, 193, 0), 24],
  [ipv4(192, 88, 99, 0), 24],
  [ipv4(192, 168, 0, 0), 16],
  [ipv4(192, 175, 48, 0), 24],
  [ipv4(198, 18, 0, 0), 15],
  [ipv4(198, 51, 100, 0), 24],
  [ipv4(203, 0, 113, 0), 24],
  [ipv4(224, 0, 0, 0), 4],
  [ipv4(240, 0, 0, 0), 4]
];

export function parseIpv4(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

function inIpv4Range(value: number, [base, prefixLength]: Ipv4Range): boolean {
  if (prefixLength === 0) return true;
  const mask = (0xffffffff << (32 - prefixLength)) >>> 0;
  return (value & mask) >>> 0 === base;
}

export function isPublicIpv4(address: string): boolean {
  const value = parseIpv4(address);
  if (value === null) return false;
  return !NON_PUBLIC_IPV4_RANGES.some((range) => inIpv4Range(value, range));
}

function parseHextets(part: string): number[] | null {
  if (part === '') return [];
  const groups = part.split(':');
  const result: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
    result.push(Number.parseInt(group, 16));
  }
  return result;
}

function splitEmbeddedIpv4(address: string): [string, number[]] | null {
  const lastColon = address.lastIndexOf(':');
  const tail = address.slice(lastColon + 1);
  if (!tail.includes('.')) return [address, []];
  const value = parseIpv4(tail);
  if (value === null) return null;
  // Keep a trailing ':' when the IPv4 tail follows '::' directly.
  const head = address.slice(0, lastColon + 1);
  const normalizedHead = head.endsWith('::') ? head : head.slice(0, -1);
  return [normalizedHead, [value >>> 16, value & 0xffff]];
}

/** Parses an IPv6 address (optionally bracketed or zoned) into 8 hextets. */
export function parseIpv6(input: string): number[] | null {
  let address = input.trim().toLowerCase();
  if (address.startsWith('[') && address.endsWith(']')) {
    address = address.slice(1, -1);
  }
  const zoneIndex = address.indexOf('%');
  if (zoneIndex >= 0) address = address.slice(0, zoneIndex);
  const split = splitEmbeddedIpv4(address);
  if (!split) return null;
  const [hexPart, ipv4Tail] = split;
  const doubleColon = hexPart.indexOf('::');
  if (doubleColon !== hexPart.lastIndexOf('::')) return null;
  const expectedHextets = 8 - ipv4Tail.length;
  if (doubleColon < 0) {
    const hextets = parseHextets(hexPart);
    if (hextets?.length !== expectedHextets) return null;
    return [...hextets, ...ipv4Tail];
  }
  const head = parseHextets(hexPart.slice(0, doubleColon));
  const tail = parseHextets(hexPart.slice(doubleColon + 2));
  if (!head || !tail) return null;
  const missing = expectedHextets - head.length - tail.length;
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...tail, ...ipv4Tail];
}

function ipv4FromHextets(high: number, low: number): string {
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

function allZero(values: number[]): boolean {
  return values.every((value) => value === 0);
}

/**
 * IPv6 forms that carry an IPv4 destination. Returns the embedded IPv4
 * address, null when the block is never public, or undefined otherwise.
 */
function embeddedIpv4(h: number[]): string | null | undefined {
  // ::ffff:a.b.c.d (mapped) and ::ffff:0:a.b.c.d (translated)
  if (allZero(h.slice(0, 5)) && h[5] === 0xffff) {
    return ipv4FromHextets(h[6], h[7]);
  }
  if (allZero(h.slice(0, 4)) && h[4] === 0xffff && h[5] === 0) {
    return ipv4FromHextets(h[6], h[7]);
  }
  // ::/96 holds the unspecified and loopback addresses and the deprecated
  // IPv4-compatible form; none of it is a public destination.
  if (allZero(h.slice(0, 6))) return null;
  // 64:ff9b::/96 well-known NAT64 prefix
  if (h[0] === 0x64 && h[1] === 0xff9b && allZero(h.slice(2, 6))) {
    return ipv4FromHextets(h[6], h[7]);
  }
  // 64:ff9b:1::/48 local-use NAT64 prefix
  if (h[0] === 0x64 && h[1] === 0xff9b && h[2] === 1) return null;
  // 2002::/16 6to4
  if (h[0] === 0x2002) return ipv4FromHextets(h[1], h[2]);
  return undefined;
}

export function isPublicIpv6(address: string): boolean {
  const h = parseIpv6(address);
  if (!h) return false;
  const embedded = embeddedIpv4(h);
  if (embedded !== undefined) {
    return embedded !== null && isPublicIpv4(embedded);
  }
  // Only 2000::/3 is allocated as global unicast. Everything else (ULA,
  // link-local, site-local, multicast, discard, ...) is non-public.
  if ((h[0] & 0xe000) !== 0x2000) return false;
  // 2001::/23 IETF protocol assignments (Teredo, benchmarking, ORCHID, ...)
  if (h[0] === 0x2001 && h[1] < 0x0200) return false;
  // 2001:db8::/32 and 3fff::/20 documentation
  if (h[0] === 0x2001 && h[1] === 0x0db8) return false;
  if (h[0] === 0x3fff && h[1] < 0x1000) return false;
  return true;
}

/** True only for literal IPv4/IPv6 addresses that are globally reachable. */
export function isPublicIpAddress(address: string): boolean {
  const trimmed = address.trim();
  const unbracketed =
    trimmed.startsWith('[') && trimmed.endsWith(']')
      ? trimmed.slice(1, -1)
      : trimmed;
  const withoutZone = unbracketed.split('%')[0] ?? '';
  switch (isIP(withoutZone)) {
    case 4:
      return isPublicIpv4(withoutZone);
    case 6:
      return isPublicIpv6(withoutZone);
    default:
      return false;
  }
}
