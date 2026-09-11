import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { nftLinkMediaPreviewService } from '@/nft-links/nft-link-media-preview.service';

it.each(['jpeg', 'png', 'webp', 'tiff', 'avif', 'svg', 'gif'])(
  'renders real %s NFT preview variants through the dynamic Sharp loader',
  async (format) => {
    const input = readFileSync(
      join(__dirname, '../../scripts/media-fixtures', format)
    );
    const rendered =
      await nftLinkMediaPreviewService['renderPreviewVariants'](input);
    for (const bytes of [rendered.thumb, rendered.small, rendered.card]) {
      const meta = await sharp(bytes).metadata();
      expect(meta.format).toBe('webp');
      expect(meta.width).toBe(format === 'jpeg' ? 12 : 24);
      expect(meta.height).toBe(format === 'jpeg' ? 24 : 12);
      expect(meta.pages).toBeUndefined();
      expect(meta.exif).toBeUndefined();
    }
  }
);
