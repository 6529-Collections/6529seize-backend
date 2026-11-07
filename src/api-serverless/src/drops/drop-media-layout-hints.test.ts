import { dropMediaLayoutHints } from './drop-media-layout-hints';

describe('dropMediaLayoutHints', () => {
  it('passes known hints through', () => {
    expect(
      dropMediaLayoutHints({
        media_width: 640,
        media_height: '480' as never,
        media_thumbhash: 'HBkSHYSIeHiPiHh8eJd4eTN0EEQG'
      })
    ).toEqual({
      width: 640,
      height: 480,
      thumbhash: 'HBkSHYSIeHiPiHh8eJd4eTN0EEQG'
    });
  });

  it('omits unknown hints so older payloads keep their shape', () => {
    expect(dropMediaLayoutHints({})).toEqual({});
    expect(
      dropMediaLayoutHints({
        media_width: null,
        media_height: null,
        media_thumbhash: null
      })
    ).toEqual({});
  });

  it('never sends half a size', () => {
    expect(
      dropMediaLayoutHints({ media_width: 640, media_height: null })
    ).toEqual({});
    expect(dropMediaLayoutHints({ media_width: 0, media_height: 10 })).toEqual(
      {}
    );
  });
});
