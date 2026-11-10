import * as fc from 'fast-check';
import { clientFamilyOf } from './client-family';

describe('clientFamilyOf', () => {
  it.each([
    [null, 'none'],
    [undefined, 'none'],
    ['   ', 'none'],
    [
      'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) 6529CORE/0.3.7 Chrome/124.0.0.0 Electron/30.0.0 Safari/537.36',
      'desktop'
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      'browser'
    ],
    ['node', 'node'],
    ['node-fetch/1.0 (+https://github.com/bitinn/node-fetch)', 'node'],
    ['axios/1.7.2', 'node'],
    ['undici', 'node'],
    ['python-requests/2.31.0', 'python'],
    ['curl/8.4.0', 'curl'],
    ['Go-http-client/1.1', 'other'],
    ['nodejs-bot', 'other']
  ])('classifies %p as %p', (userAgent, family) => {
    expect(clientFamilyOf(userAgent)).toBe(family);
  });

  it('only ever reports a known family', () => {
    const families = new Set([
      'desktop',
      'browser',
      'node',
      'python',
      'curl',
      'other',
      'none'
    ]);
    fc.assert(
      fc.property(fc.option(fc.string()), (userAgent) => {
        expect(families.has(clientFamilyOf(userAgent))).toBe(true);
      })
    );
  });
});
