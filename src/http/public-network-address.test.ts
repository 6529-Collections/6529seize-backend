import fc from 'fast-check';
import {
  isPublicIpAddress,
  isPublicIpv4,
  isPublicIpv6,
  parseIpv6
} from './public-network-address';

describe('isPublicIpAddress', () => {
  it.each([
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '100.127.255.255',
    '127.0.0.1',
    '127.255.255.254',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.0.0.8',
    '192.0.2.1',
    '192.88.99.1',
    '192.168.1.1',
    '198.18.0.1',
    '198.19.255.255',
    '198.51.100.7',
    '203.0.113.9',
    '224.0.0.1',
    '239.255.255.250',
    '240.0.0.1',
    '255.255.255.255'
  ])('treats IPv4 %s as non-public', (address) => {
    expect(isPublicIpAddress(address)).toBe(false);
  });

  it.each([
    '::',
    '::1',
    '[::1]',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:10.0.0.1',
    '::ffff:169.254.169.254',
    '::ffff:0:a9fe:a9fe',
    '::127.0.0.1',
    '::8.8.8.8',
    '64:ff9b::7f00:1',
    '64:ff9b::10.0.0.1',
    '64:ff9b:1::808:808',
    '2002:7f00:1::1',
    '2002:a9fe:a9fe::',
    '2001::1',
    '2001:db8::1',
    '3fff::1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'fe80::1%eth0',
    'febf::1',
    'fec0::1',
    'ff02::1',
    '100::1'
  ])('treats IPv6 %s as non-public', (address) => {
    expect(isPublicIpAddress(address)).toBe(false);
  });

  it.each([
    '1.1.1.1',
    '8.8.8.8',
    '93.184.216.34',
    '172.15.255.255',
    '172.32.0.1',
    '100.63.255.255',
    '100.128.0.1',
    '2001:4860:4860::8888',
    '2606:4700:4700::1111',
    '[2a00:1450:4001:80b::200e]',
    '::ffff:8.8.8.8',
    '64:ff9b::808:808',
    '2002:808:808::1'
  ])('treats %s as public', (address) => {
    expect(isPublicIpAddress(address)).toBe(true);
  });

  it.each(['', 'localhost', 'example.com', '1.2.3', '01.2.3.4', '1.2.3.256'])(
    'treats non-address %p as non-public',
    (value) => {
      expect(isPublicIpAddress(value)).toBe(false);
    }
  );

  it('agrees between dotted and mapped hex IPv4 forms', () => {
    fc.assert(
      fc.property(fc.ipV4(), (address) => {
        const [a, b, c, d] = address.split('.').map(Number);
        const hex = `::ffff:${((a << 8) | b).toString(16)}:${(
          (c << 8) |
          d
        ).toString(16)}`;
        expect(isPublicIpv6(hex)).toBe(isPublicIpv4(address));
        expect(isPublicIpv6(`::ffff:${address}`)).toBe(isPublicIpv4(address));
      })
    );
  });

  it('never treats link-local, unique-local or multicast IPv6 as public', () => {
    const hextet = fc.integer({ min: 0, max: 0xffff });
    fc.assert(
      fc.property(
        fc.constantFrom(0xfe80, 0xfc00, 0xfd00, 0xff00, 0xfe90, 0xfebf),
        fc.array(hextet, { minLength: 7, maxLength: 7 }),
        (first, rest) => {
          const address = [first, ...rest].map((h) => h.toString(16)).join(':');
          expect(isPublicIpAddress(address)).toBe(false);
        }
      )
    );
  });

  it('never treats 10/8, 127/8 or 169.254/16 as public', () => {
    const octet = fc.integer({ min: 0, max: 255 });
    fc.assert(
      fc.property(octet, octet, octet, (b, c, d) => {
        expect(isPublicIpv4(`10.${b}.${c}.${d}`)).toBe(false);
        expect(isPublicIpv4(`127.${b}.${c}.${d}`)).toBe(false);
        expect(isPublicIpv4(`169.254.${c}.${d}`)).toBe(false);
      })
    );
  });
});

describe('parseIpv6', () => {
  it.each([
    ['::', [0, 0, 0, 0, 0, 0, 0, 0]],
    ['::1', [0, 0, 0, 0, 0, 0, 0, 1]],
    ['1::', [1, 0, 0, 0, 0, 0, 0, 0]],
    ['::ffff:1.2.3.4', [0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]],
    ['1:2:3:4:5:6:7:8', [1, 2, 3, 4, 5, 6, 7, 8]],
    ['[fe80::1%25eth0]', [0xfe80, 0, 0, 0, 0, 0, 0, 1]]
  ])('parses %s', (input, expected) => {
    expect(parseIpv6(input)).toEqual(expected);
  });

  it.each([':::', '1:2:3:4:5:6:7:8:9', '1::2::3', 'g::1', '::1.2.3'])(
    'rejects %s',
    (input) => {
      expect(parseIpv6(input)).toBeNull();
    }
  );
});
