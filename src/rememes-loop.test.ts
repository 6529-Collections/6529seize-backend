import { Rememe, RememeS3ProcessingStatus } from './entities/IRememe';
import { rememeS3FieldsForRefresh } from './rememesLoop';

describe('rememeS3FieldsForRefresh', () => {
  it('preserves existing S3 state when the metadata image URL is unchanged', () => {
    const lastAttempt = new Date('2026-06-26T00:00:00.000Z');
    const existing = {
      image: 'ipfs://unchanged',
      media: {},
      s3_image_original: 'https://cdn.test/original.webp',
      s3_image_scaled: 'https://cdn.test/scaled.webp',
      s3_image_thumbnail: 'https://cdn.test/thumbnail.webp',
      s3_image_icon: 'https://cdn.test/icon.webp',
      s3_image_processing_status: RememeS3ProcessingStatus.TRANSIENT_ERROR,
      s3_image_processing_error: 'temporary failure',
      s3_image_last_attempt_at: lastAttempt,
      s3_image_processing_attempts: null
    } as Rememe;

    expect(rememeS3FieldsForRefresh(existing, 'ipfs://unchanged')).toEqual({
      s3_image_original: 'https://cdn.test/original.webp',
      s3_image_scaled: 'https://cdn.test/scaled.webp',
      s3_image_thumbnail: 'https://cdn.test/thumbnail.webp',
      s3_image_icon: 'https://cdn.test/icon.webp',
      s3_image_processing_status: RememeS3ProcessingStatus.TRANSIENT_ERROR,
      s3_image_processing_error: 'temporary failure',
      s3_image_last_attempt_at: lastAttempt,
      s3_image_processing_attempts: null
    });
  });

  it('resets S3 state when the metadata image URL changes', () => {
    const existing = {
      image: 'ipfs://old',
      s3_image_original: 'https://cdn.test/original.webp',
      s3_image_scaled: 'https://cdn.test/scaled.webp',
      s3_image_thumbnail: 'https://cdn.test/thumbnail.webp',
      s3_image_icon: 'https://cdn.test/icon.webp',
      s3_image_processing_status: RememeS3ProcessingStatus.COMPLETE,
      s3_image_processing_error: null,
      s3_image_last_attempt_at: new Date('2026-06-26T00:00:00.000Z'),
      s3_image_processing_attempts: 0
    } as Rememe;

    expect(rememeS3FieldsForRefresh(existing, 'ipfs://new')).toEqual({
      s3_image_original: null,
      s3_image_scaled: null,
      s3_image_thumbnail: null,
      s3_image_icon: null,
      s3_image_processing_status: null,
      s3_image_processing_error: null,
      s3_image_last_attempt_at: null,
      s3_image_processing_attempts: 0
    });
  });
});
