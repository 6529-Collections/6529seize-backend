import { normalizeWalletGalleryMedia } from '@/profile-cms/wallet-gallery/wallet-gallery-media-normalizer';

describe('normalizeWalletGalleryMedia', () => {
  it('returns deterministic preview fallbacks for static image assets', () => {
    expect(
      normalizeWalletGalleryMedia({
        image: ' https://example.test/full.png?cache=1 ',
        scaled: 'https://example.test/scaled.webp',
        thumbnail: 'https://example.test/thumb.jpg',
        icon: 'https://example.test/icon.gif'
      })
    ).toEqual({
      image: 'https://example.test/full.png?cache=1',
      image_preview: 'https://example.test/scaled.webp',
      thumbnail: 'https://example.test/thumb.jpg',
      animation: null,
      animation_preview: null,
      mime_type: 'image/png'
    });
  });

  it('prefers compressed animation for animation previews', () => {
    expect(
      normalizeWalletGalleryMedia({
        image: 'https://example.test/image.png',
        animation: 'https://example.test/animation.mp4',
        compressed_animation: 'https://example.test/animation-preview.webm'
      })
    ).toEqual({
      image: 'https://example.test/image.png',
      image_preview: 'https://example.test/image.png',
      thumbnail: 'https://example.test/image.png',
      animation: 'https://example.test/animation.mp4',
      animation_preview: 'https://example.test/animation-preview.webm',
      mime_type: 'video/mp4'
    });
  });

  it('returns nulls when no media URLs are indexed', () => {
    expect(normalizeWalletGalleryMedia({ image: '', thumbnail: '  ' })).toEqual(
      {
        image: null,
        image_preview: null,
        thumbnail: null,
        animation: null,
        animation_preview: null,
        mime_type: null
      }
    );
  });
});
