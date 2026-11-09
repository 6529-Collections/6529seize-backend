import { DropMediaEntity } from '@/entities/IDrop';
import { DropMediaUploadStatus } from '@/entities/IDropMediaUpload';
import { mapDropMedia } from './drop-media.mapper';

const media: DropMediaEntity = {
  id: 'media',
  drop_id: 'drop',
  drop_part_id: 1,
  wave_id: 'wave',
  url: 'https://example.com/sanitized.png',
  mime_type: 'image/png',
  media_upload_id: 'upload'
};

it.each([
  [DropMediaUploadStatus.UPLOADING, 'uploading'],
  [DropMediaUploadStatus.COMPLETING, 'processing'],
  [DropMediaUploadStatus.PROCESSING, 'processing'],
  [DropMediaUploadStatus.SANITIZING, 'processing'],
  [DropMediaUploadStatus.READY, 'ready'],
  [DropMediaUploadStatus.FAILED, 'failed'],
  [null, 'ready']
])(
  'maps %s without discarding upload identity or layout hints',
  (status, expected) => {
    expect(
      mapDropMedia({
        ...media,
        media_status: status,
        media_error: 'failure-code',
        media_width: 927,
        media_height: 447,
        media_thumbhash: 'placeholder'
      })
    ).toEqual({
      url: media.url,
      mime_type: 'image/png',
      media_upload_id: 'upload',
      media_status: expected,
      media_error: 'failure-code',
      width: 927,
      height: 447,
      thumbhash: 'placeholder'
    });
  }
);
