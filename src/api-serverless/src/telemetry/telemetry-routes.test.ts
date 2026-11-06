import fc from 'fast-check';
import {
  sanitizeEndpointTemplate,
  sanitizePageGroup,
  sanitizePageRoute,
  sanitizeReferrerDomain
} from '@/api/telemetry/telemetry-routes';

describe('telemetry route templates', () => {
  it('never keeps a route with an id-looking or unknown static root', () => {
    fc.assert(
      fc.property(fc.string(), (value) => {
        const route = sanitizePageRoute(`/${value}`);
        return (
          route === '/[other]' ||
          route === '/' ||
          !/\d{6,}|\/0x|@|\?|#|\s/.test(route ?? '')
        );
      })
    );
  });

  it('folds handles at the root even when they look like slugs', () => {
    expect(sanitizePageRoute('/punk6529')).toBe('/[other]');
    expect(sanitizePageRoute('/6529er')).toBe('/[other]');
    expect(sanitizePageRoute('/waves')).toBe('/waves');
  });

  it('applies the same rules to API endpoint templates', () => {
    expect(sanitizeEndpointTemplate('/api/waves/[id]/drops')).toBe(
      '/waves/[id]/drops'
    );
    expect(sanitizeEndpointTemplate('/waves/[id]/drops')).toBe(
      '/waves/[id]/drops'
    );
    expect(sanitizeEndpointTemplate('/profiles/1234567')).toBe('/[other]');
    expect(sanitizeEndpointTemplate('/not-an-api/[id]')).toBe('/[other]');
    expect(sanitizeEndpointTemplate(`/drops/${'x'.repeat(200)}`)).toBe(
      '/[other]'
    );
  });

  it('maps unknown page groups to other', () => {
    expect(sanitizePageGroup('waves')).toBe('waves');
    expect(sanitizePageGroup('profile')).toBe('profile');
    expect(sanitizePageGroup('punk6529')).toBe('other');
    expect(sanitizePageGroup(7)).toBeNull();
  });
});

describe('sanitizeReferrerDomain', () => {
  it('keeps external hostnames only', () => {
    expect(sanitizeReferrerDomain('www.Google.com')).toBe('google.com');
    expect(sanitizeReferrerDomain('t.co')).toBe('t.co');
    expect(sanitizeReferrerDomain('6529.io')).toBe('');
    expect(sanitizeReferrerDomain('staging.6529.io')).toBe('');
    expect(sanitizeReferrerDomain('203.0.113.7')).toBe('');
    expect(sanitizeReferrerDomain('localhost')).toBe('');
    expect(sanitizeReferrerDomain('example.com:8080')).toBe('');
    expect(sanitizeReferrerDomain('https://example.com/path')).toBe('');
    expect(sanitizeReferrerDomain(null)).toBe('');
  });
});
