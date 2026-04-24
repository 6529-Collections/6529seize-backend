import {
  DROP_MEDIA_ALLOWED_EXTENSIONS_BY_MIME_TYPE,
  DROP_MEDIA_ALLOWED_MIME_TYPES
} from '@/api/media/media-mime-types';
import { createMediaPrepRequestSchema } from '@/api/media/media-uplodad.validators';

describe('media upload validators', () => {
  const schema = createMediaPrepRequestSchema({
    allowedMimeTypes: [...DROP_MEDIA_ALLOWED_MIME_TYPES],
    allowedExtensionsByMimeType: DROP_MEDIA_ALLOWED_EXTENSIONS_BY_MIME_TYPE
  });

  it.each([
    ['application/pdf', 'upload.pdf'],
    ['text/csv', 'upload.csv'],
    ['image/webp', 'upload.webp'],
    ['image/png', 'upload.png'],
    ['image/jpeg', 'upload.jpg'],
    ['image/jpeg', 'upload.jpeg'],
    ['image/jpg', 'upload.jpg'],
    ['image/jpg', 'upload.jpeg'],
    ['image/gif', 'upload.gif'],
    ['video/mp4', 'upload.mp4'],
    ['video/x-msvideo', 'upload.avi'],
    ['video/quicktime', 'upload.mov'],
    ['audio/mpeg', 'upload.mp3'],
    ['audio/ogg', 'upload.ogg'],
    ['audio/wav', 'upload.wav'],
    ['audio/aac', 'upload.aac'],
    ['model/gltf-binary', 'upload.glb']
  ])('allows drop media %s file %s', (contentType, fileName) => {
    const { error } = schema.validate({
      author: 'profile-id',
      content_type: contentType,
      file_name: fileName
    });

    expect(error).toBeUndefined();
  });

  it('rejects unsupported drop media content types', () => {
    const { error } = schema.validate({
      author: 'profile-id',
      content_type: 'application/json',
      file_name: 'upload.json'
    });

    expect(error).toBeDefined();
  });

  it.each([
    ['application/pdf', 'upload.exe'],
    ['application/pdf', 'upload.pdf.exe'],
    ['application/pdf', 'upload.exe.pdf'],
    ['text/csv', 'upload.pdf'],
    ['image/webp', 'upload.png'],
    ['image/png', '../upload.png'],
    ['image/png', ' folder/upload.png'],
    ['image/png', 'upload.png ']
  ])('rejects drop media %s file name %s', (contentType, fileName) => {
    const { error } = schema.validate({
      author: 'profile-id',
      content_type: contentType,
      file_name: fileName
    });

    expect(error).toBeDefined();
  });
});
