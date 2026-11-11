import * as fc from 'fast-check';
import { BadRequestException } from '@/exceptions';
import {
  assertLegacyCmsJsonBounded,
  isUnsafeUrlString,
  LEGACY_CMS_MAX_PACKAGE_JSON_BYTES
} from './cms-package-bounds';

describe('isUnsafeUrlString', () => {
  it.each([
    'javascript:alert(1)',
    'JAVASCRIPT:alert(1)',
    '  javascript:alert(1)',
    '\u0001javascript:alert(1)',
    'java\tscript:alert(1)',
    'java\nscript:alert(1)',
    'vbscript:msgbox(1)',
    'data:text/html,<p>x</p>',
    'Data:image/svg+xml;base64,AAAA'
  ])('flags %j', (value) => {
    expect(isUnsafeUrlString(value)).toBe(true);
  });

  it.each([
    'https://6529.io/punk6529',
    'ipfs://bafyexample',
    '/memes-preview.png',
    'Collected Signals',
    'see javascript:void(0) in the docs'
  ])('accepts %j', (value) => {
    expect(isUnsafeUrlString(value)).toBe(false);
  });

  it('accepts any https URL', () => {
    fc.assert(
      fc.property(fc.webUrl({ validSchemes: ['https'] }), (url) => {
        expect(isUnsafeUrlString(url)).toBe(false);
      })
    );
  });
});

describe('assertLegacyCmsJsonBounded', () => {
  it('accepts an ordinary package', () => {
    expect(() =>
      assertLegacyCmsJsonBounded(
        { payload: { blocks: [{ url: 'https://6529.io' }] } },
        'package_json',
        LEGACY_CMS_MAX_PACKAGE_JSON_BYTES
      )
    ).not.toThrow();
  });

  it('rejects an unsafe URL nested in an array', () => {
    expect(() =>
      assertLegacyCmsJsonBounded(
        { payload: { blocks: [{ links: ['data:text/html,x'] }] } },
        'package_json',
        LEGACY_CMS_MAX_PACKAGE_JSON_BYTES
      )
    ).toThrow(BadRequestException);
  });

  it('rejects a document over the byte cap', () => {
    expect(() =>
      assertLegacyCmsJsonBounded(
        { text: 'x'.repeat(LEGACY_CMS_MAX_PACKAGE_JSON_BYTES) },
        'package_json',
        LEGACY_CMS_MAX_PACKAGE_JSON_BYTES
      )
    ).toThrow(
      new BadRequestException(
        `package_json must not exceed ${LEGACY_CMS_MAX_PACKAGE_JSON_BYTES} bytes.`
      )
    );
  });

  it('rejects deep nesting', () => {
    let nested: unknown = 'leaf';
    for (let i = 0; i < 40; i++) {
      nested = { nested };
    }
    expect(() =>
      assertLegacyCmsJsonBounded(nested, 'package_json', 1024 * 1024)
    ).toThrow(
      new BadRequestException('package_json is too deeply nested or large.')
    );
  });

  it('rejects too many nodes', () => {
    expect(() =>
      assertLegacyCmsJsonBounded(
        new Array(60000).fill(0),
        'package_json',
        1024 * 1024
      )
    ).toThrow(BadRequestException);
  });

  it('rejects prototype property names', () => {
    expect(() =>
      assertLegacyCmsJsonBounded(
        JSON.parse('{"__proto__": {"x": 1}}'),
        'package_json',
        1024
      )
    ).toThrow(BadRequestException);
  });
});
