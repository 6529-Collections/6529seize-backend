import fc from 'fast-check';
import {
  sanitizeTelemetryBatch,
  sanitizeTelemetryEvent
} from '@/api/telemetry/telemetry-sanitizer';

const base = {
  v: 1,
  route: '/waves/[wave]',
  device: 'desktop',
  platform: 'web'
};

describe('sanitizeTelemetryEvent', () => {
  it('keeps only schema fields of a page view and drops unknown ones', () => {
    const event = sanitizeTelemetryEvent({
      ...base,
      t: 'pv',
      page_group: 'waves',
      prev_route: 'entry',
      referrer_domain: 'www.Example.com',
      browser: 'firefox',
      signed_in: true,
      fp: 'abcDEF12_-',
      url: 'https://6529.io/waves/123?token=secret',
      title: 'The Memes - Main Stage',
      handle: 'punk6529',
      wallet: '0xabc'
    });
    expect(event).toEqual({
      t: 'pv',
      route: '/waves/[wave]',
      device: 'desktop',
      platform: 'web',
      pageGroup: 'waves',
      prevRoute: 'entry',
      referrerDomain: 'example.com',
      browser: 'firefox',
      signedIn: true,
      fp: 'abcDEF12_-'
    });
    expect(JSON.stringify(event)).not.toMatch(
      /token|Main Stage|punk6529|0xabc/
    );
  });

  it('only keeps the referrer for entries', () => {
    const event = sanitizeTelemetryEvent({
      ...base,
      t: 'pv',
      prev_route: '/waves',
      referrer_domain: 'example.com'
    });
    expect(event).toMatchObject({ prevRoute: '/waves', referrerDomain: '' });
  });

  it('drops a malformed fp', () => {
    for (const fp of ['short', 'has space in it', 'x'.repeat(33), 12345678]) {
      expect(sanitizeTelemetryEvent({ ...base, t: 'pv', fp })).toMatchObject({
        fp: null
      });
    }
  });

  it('folds untemplated routes into /[other]', () => {
    for (const route of [
      '/punk6529',
      '/waves/0x33fd426905f149f8376e227d0c9d3340aad17af1',
      '/waves/8f14e45f-ceea-467a-9575-1b9f2c1a0b2e',
      '/the-memes/123',
      '/waves/1234567x',
      '/Waves',
      '/waves/',
      '/waves?drop=1',
      `/${'a/'.repeat(10)}a`
    ]) {
      expect(sanitizeTelemetryEvent({ ...base, t: 'pv', route })).toMatchObject(
        { route: '/[other]' }
      );
    }
  });

  it('keeps known templates', () => {
    for (const route of [
      '/',
      '/[user]',
      '/[user]/collected',
      '/:handle/collected',
      '/waves/[wave]',
      '/the-memes/[id]',
      '/tools/[...slug]',
      '/the-memes/[[...slug]]'
    ]) {
      expect(sanitizeTelemetryEvent({ ...base, t: 'pv', route })).toMatchObject(
        { route }
      );
    }
  });

  it('drops events with a wrong version, type, device or platform', () => {
    expect(sanitizeTelemetryEvent({ ...base, v: 2, t: 'pv' })).toBeNull();
    expect(sanitizeTelemetryEvent({ ...base, t: 'click' })).toBeNull();
    expect(
      sanitizeTelemetryEvent({ ...base, t: 'pv', device: 'watch' })
    ).toBeNull();
    expect(
      sanitizeTelemetryEvent({ ...base, t: 'pv', platform: 'tv' })
    ).toBeNull();
    expect(sanitizeTelemetryEvent({ ...base, t: 'pv', route: 5 })).toBeNull();
  });

  it('keeps vitals in range and drops the rest', () => {
    expect(
      sanitizeTelemetryEvent({
        ...base,
        t: 'vitals',
        lcp: 2400,
        inp: -1,
        ttfb: 400000,
        fcp: 'fast',
        cls: 0.12,
        memory: 1234
      })
    ).toEqual({
      ...{ route: '/waves/[wave]', device: 'desktop', platform: 'web' },
      t: 'vitals',
      metrics: [
        { metric: 'lcp', value: 2400 },
        { metric: 'cls', value: 0.12 }
      ]
    });
    expect(sanitizeTelemetryEvent({ ...base, t: 'vitals' })).toBeNull();
  });

  it('keeps registered product event props and drops everything else', () => {
    expect(
      sanitizeTelemetryEvent({
        ...base,
        t: 'ev',
        name: 'Homepage action clicked',
        p: {
          section: 'Latest drop',
          action: 'Mint',
          signed_in: false,
          is_native: 'yes',
          screen_size: 'Huge',
          wallet: '0xabc',
          handle: 'punk6529'
        }
      })
    ).toMatchObject({
      t: 'ev',
      name: 'Homepage action clicked',
      props: { section: 'Latest drop', action: 'Mint', signed_in: 'false' }
    });
    expect(
      sanitizeTelemetryEvent({ ...base, t: 'ev', name: 'Unknown event', p: {} })
    ).toBeNull();
    expect(
      sanitizeTelemetryEvent({ ...base, t: 'ev', name: 'toString', p: {} })
    ).toBeNull();
  });

  it('sanitizes health counters and folds endpoint templates', () => {
    expect(
      sanitizeTelemetryEvent({
        ...base,
        t: 'health',
        c: {
          ws_drop: 2,
          long_task: 0,
          asset_fail: { script: 1, flash: 3 },
          api_fail: {
            '/api/drops/[id]': 2,
            '/drops/0x33fd426905f149f8376e227d0c9d3340aad17af1': 1,
            '/profiles/[handle]': 1,
            '/unknown-root/[id]': 4
          },
          error: { chunk_load: 1, oops: 1 },
          secret: 9
        },
        ws_lag: 120
      })
    ).toEqual({
      route: '/waves/[wave]',
      device: 'desktop',
      platform: 'web',
      t: 'health',
      counters: [
        { counter: 'ws_drop', dim: '', count: 2 },
        { counter: 'asset_fail', dim: 'script', count: 1 },
        { counter: 'error', dim: 'chunk_load', count: 1 },
        { counter: 'api_fail', dim: '/drops/[id]', count: 2 },
        { counter: 'api_fail', dim: '/[other]', count: 5 },
        { counter: 'api_fail', dim: '/profiles/[handle]', count: 1 }
      ],
      wsLag: 120
    });
  });
});

describe('sanitizeTelemetryBatch', () => {
  it('drops batches with an unknown version or shape', () => {
    expect(sanitizeTelemetryBatch({ v: 2, events: [] })).toEqual([]);
    expect(sanitizeTelemetryBatch({ v: 1, events: 'x' })).toEqual([]);
    expect(sanitizeTelemetryBatch([1, 2])).toEqual([]);
    expect(sanitizeTelemetryBatch(null)).toEqual([]);
  });

  it('caps the number of events', () => {
    const events = Array.from({ length: 100 }, () => ({ ...base, t: 'pv' }));
    expect(sanitizeTelemetryBatch({ v: 1, events })).toHaveLength(40);
  });

  it('never copies a string it was not designed to keep', () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string(), fc.jsonValue()),
        fc.string({ minLength: 6 }).map((s) => `zz${s}zz`),
        (extra, marker) => {
          const events = sanitizeTelemetryBatch({
            v: 1,
            events: [
              { ...extra, ...base, t: 'pv', note: marker, [marker]: marker }
            ]
          });
          return !JSON.stringify(events).includes(marker);
        }
      )
    );
  });
});
