import { InMemoryObjectStore } from '@/tests/fixtures/media-object-store.fixture';
import { hasLocationMarker, probeVideoLocation } from './video-location-probe';

describe('probeVideoLocation', () => {
  it.each([
    ['©xyz', Buffer.from([0xa9, 0x78, 0x79, 0x7a])],
    ['Apple ISO 6709 key', Buffer.from('com.apple.quicktime.location.ISO6709')],
    ['GoPro GPMF', Buffer.from('GPMF')]
  ])('recognizes %s', (_name, marker) => {
    expect(hasLocationMarker(Buffer.concat([Buffer.alloc(10), marker]))).toBe(
      true
    );
  });

  it('reads only bounded windows from each end', async () => {
    const store = new InMemoryObjectStore('public');
    const tailMarker = Buffer.concat([
      Buffer.alloc(5000),
      Buffer.from('com.apple.quicktime.location.ISO6709')
    ]);
    store.seed('drops/a/v.mp4', tailMarker);
    const result = await probeVideoLocation(store, 'drops/a/v.mp4', 1024);
    expect(result).toEqual({
      kind: 'probed',
      likelyLocation: true,
      size: tailMarker.length
    });
    expect(store.operations.filter((op) => op.startsWith('range'))).toEqual([
      'range drops/a/v.mp4 0-1023',
      `range drops/a/v.mp4 ${tailMarker.length - 1024 - 64}-${tailMarker.length - 1}`
    ]);
  });

  it('reports videos without markers and missing objects', async () => {
    const store = new InMemoryObjectStore('public');
    store.seed('drops/a/plain.mp4', Buffer.alloc(100));
    expect(await probeVideoLocation(store, 'drops/a/plain.mp4', 1024)).toEqual({
      kind: 'probed',
      likelyLocation: false,
      size: 100
    });
    expect(await probeVideoLocation(store, 'drops/a/none.mp4')).toEqual({
      kind: 'missing'
    });
  });
});
