import { describe, expect, it } from '@jest/globals';
import {
  isForbiddenHostname,
  isPrivateIp,
  parseAndValidatePublicHttpUrl
} from './safe-fetch';

describe('safe-fetch', () => {
  describe('isPrivateIp', () => {
    it('detects private IPv4 ranges', () => {
      expect(isPrivateIp('127.0.0.1')).toBe(true);
      expect(isPrivateIp('10.0.0.1')).toBe(true);
      expect(isPrivateIp('100.64.0.1')).toBe(true);
      expect(isPrivateIp('192.168.1.1')).toBe(true);
      expect(isPrivateIp('172.16.0.1')).toBe(true);
      expect(isPrivateIp('169.254.169.254')).toBe(true);
    });

    it('detects private IPv6 ranges', () => {
      expect(isPrivateIp('::1')).toBe(true);
      expect(isPrivateIp('fe80::1')).toBe(true);
      expect(isPrivateIp('fc00::1')).toBe(true);
      expect(isPrivateIp('fd00::1')).toBe(true);
      expect(isPrivateIp('::ffff:127.0.0.1')).toBe(true);
      expect(isPrivateIp('::ffff:7f00:1')).toBe(true);
    });

    it('treats public IPs as public', () => {
      expect(isPrivateIp('1.1.1.1')).toBe(false);
      expect(isPrivateIp('8.8.8.8')).toBe(false);
    });
  });

  describe('isForbiddenHostname', () => {
    it('blocks localhost hostnames', () => {
      expect(isForbiddenHostname('localhost')).toBe(true);
      expect(isForbiddenHostname('LOCALHOST')).toBe(true);
      expect(isForbiddenHostname('a.localhost')).toBe(true);
    });
  });

  describe('parseAndValidatePublicHttpUrl', () => {
    it('rejects non-http protocols', () => {
      expect(() => parseAndValidatePublicHttpUrl('file:///etc/passwd')).toThrow(
        /Unsupported URL protocol/
      );
      expect(() => parseAndValidatePublicHttpUrl('ftp://example.com')).toThrow(
        /Unsupported URL protocol/
      );
    });

    it('rejects URLs with credentials', () => {
      expect(() =>
        parseAndValidatePublicHttpUrl('https://user:pass@example.com/a')
      ).toThrow(/credentials/);
    });

    it('rejects localhost and private IP literals', () => {
      expect(() => parseAndValidatePublicHttpUrl('http://localhost/a')).toThrow(
        /Forbidden hostname/
      );
      expect(() => parseAndValidatePublicHttpUrl('http://127.0.0.1/a')).toThrow(
        /Forbidden IP/
      );
    });

    it('accepts https URLs with public hostnames', () => {
      const url = parseAndValidatePublicHttpUrl('https://arweave.net/abc');
      expect(url.protocol).toBe('https:');
      expect(url.hostname).toBe('arweave.net');
    });
  });
});
