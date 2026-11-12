import * as fc from 'fast-check';
import { toRecordedRequestOrigin } from './web-app-origins';

describe('toRecordedRequestOrigin', () => {
  it.each([
    ['https://6529.io', 'https://6529.io'],
    [' HTTPS://6529.IO ', 'https://6529.io'],
    ['https://6529.io/', 'https://6529.io'],
    ['http://localhost:43123', 'http://localhost:43123'],
    ['capacitor://localhost', 'capacitor://localhost'],
    ['Capacitor://Localhost', 'capacitor://localhost'],
    ['null', 'null'],
    [['', 'https://6529.io'], 'https://6529.io']
  ])('records %p as %p', (header, recorded) => {
    expect(toRecordedRequestOrigin(header)).toBe(recorded);
  });

  it.each([
    undefined,
    '',
    '   ',
    42,
    'https://6529.io/path',
    'https://user@6529.io',
    'app://user@host',
    'app://host/path',
    'not an origin',
    `app://${'a'.repeat(300)}`,
    `https://${'a'.repeat(300)}.example`
  ])('records nothing for %p', (header) => {
    expect(toRecordedRequestOrigin(header)).toBeNull();
  });

  it('never records more than 255 characters or whitespace', () => {
    fc.assert(
      fc.property(fc.string(), (header) => {
        const recorded = toRecordedRequestOrigin(header);
        expect(
          recorded === null || (recorded.length <= 255 && !/\s/.test(recorded))
        ).toBe(true);
      })
    );
  });
});
