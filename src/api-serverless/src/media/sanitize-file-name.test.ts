import fc from 'fast-check';
import { sanitizeFileName, slugifyBaseName } from './sanitize-file-name';

const UUID_REGEX =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

describe('slugifyBaseName', () => {
  it('preserves ASCII alphanumerics and case', () => {
    expect(slugifyBaseName('MyVacationPhoto')).toBe('MyVacationPhoto');
  });

  it('replaces runs of non-alphanumeric chars with a single dash', () => {
    expect(slugifyBaseName('My  Vacation___Photo!!!2024')).toBe(
      'My-Vacation-Photo-2024'
    );
  });

  it('trims leading and trailing dashes', () => {
    expect(slugifyBaseName('---hello---')).toBe('hello');
  });

  it('returns empty string for empty input', () => {
    expect(slugifyBaseName('')).toBe('');
  });

  it('returns empty string when input has no alphanumerics', () => {
    expect(slugifyBaseName('!!!???...---')).toBe('');
  });

  it('strips emojis and non-ASCII characters', () => {
    expect(slugifyBaseName('🎉 My Photo 😀')).toBe('My-Photo');
    expect(slugifyBaseName('文档')).toBe('');
    expect(slugifyBaseName('café')).toBe('caf');
  });

  it('truncates to at most 60 characters without leaving a trailing dash', () => {
    const long = 'a'.repeat(50) + ' ' + 'b'.repeat(50);
    const slug = slugifyBaseName(long);
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug.endsWith('-')).toBe(false);
  });

  it('trims trailing dash when truncation lands on one', () => {
    // 59 a's then '-' (from the space) at index 59 — substring(0, 60) ends with '-'
    const input = 'a'.repeat(59) + ' ' + 'b'.repeat(10);
    const slug = slugifyBaseName(input);
    expect(slug).toBe('a'.repeat(59));
  });

  it('only ever contains [A-Za-z0-9-] (property)', () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const slug = slugifyBaseName(input);
        expect(slug).toMatch(/^[A-Za-z0-9-]*$/);
        expect(slug.startsWith('-')).toBe(false);
        expect(slug.endsWith('-')).toBe(false);
        expect(slug.length).toBeLessThanOrEqual(60);
      })
    );
  });

  it('never produces consecutive dashes (property)', () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        expect(slugifyBaseName(input)).not.toMatch(/--/);
      })
    );
  });
});

describe('sanitizeFileName', () => {
  it('prefixes the slug before the UUID and preserves the extension case', () => {
    const result = sanitizeFileName('MyVacationPhoto.JPG');
    expect(result).toMatch(
      /^MyVacationPhoto-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.JPG$/
    );
  });

  it('falls back to UUID only when the base name slugifies to empty', () => {
    const result = sanitizeFileName('🎉🎊.jpg');
    expect(result).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/
    );
  });

  it('handles names without an extension', () => {
    const result = sanitizeFileName('photo');
    expect(result).toMatch(
      /^photo-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });

  it('handles empty file name', () => {
    const result = sanitizeFileName('');
    expect(result).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });

  it('uses only the final extension for double-extension files', () => {
    const result = sanitizeFileName('archive.tar.gz');
    expect(result).toMatch(
      /^archive-tar-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.gz$/
    );
  });

  it('produces a fresh UUID on each call (two calls never collide)', () => {
    const a = sanitizeFileName('same-name.jpg');
    const b = sanitizeFileName('same-name.jpg');
    expect(a).not.toBe(b);
  });

  it('always contains a UUID (property)', () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        expect(sanitizeFileName(input)).toMatch(UUID_REGEX);
      })
    );
  });

  it('never contains characters that need URL encoding in the slug portion (property)', () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const result = sanitizeFileName(input);
        const slugPortion = result.split(UUID_REGEX)[0];
        // Slug portion is either empty or ends with "-", and contains only safe chars
        expect(slugPortion).toMatch(/^([A-Za-z0-9-]*-)?$/);
      })
    );
  });
});
