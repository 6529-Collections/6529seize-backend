import {
  DROP_MEDIA_CLOUDFRONT_ORIGIN,
  validateDropMediaAttachment
} from './create-or-update-drop.use-case';
import { DropType } from '@/entities/IDrop';

describe('validateDropMediaAttachment', () => {
  it('allows csv uploads for chat drops from CloudFront', () => {
    expect(() =>
      validateDropMediaAttachment({
        mimeType: 'text/csv',
        url: `${DROP_MEDIA_CLOUDFRONT_ORIGIN}/drops/author_1/file.csv`,
        dropType: DropType.CHAT
      })
    ).not.toThrow();
  });

  it('rejects csv uploads for participatory drops', () => {
    expect(() =>
      validateDropMediaAttachment({
        mimeType: 'text/csv',
        url: `${DROP_MEDIA_CLOUDFRONT_ORIGIN}/drops/author_1/file.csv`,
        dropType: DropType.PARTICIPATORY
      })
    ).toThrow('text/csv is only supported on chat drops');
  });

  it('rejects csv uploads outside CloudFront', () => {
    expect(() =>
      validateDropMediaAttachment({
        mimeType: 'text/csv',
        url: 'https://example.com/file.csv',
        dropType: DropType.CHAT
      })
    ).toThrow(`text/csv needs to come from ${DROP_MEDIA_CLOUDFRONT_ORIGIN}`);
  });

  it('preserves html handling', () => {
    expect(() =>
      validateDropMediaAttachment({
        mimeType: 'text/html',
        url: 'https://arweave.net/some-html',
        dropType: DropType.CHAT
      })
    ).not.toThrow();
  });
});
