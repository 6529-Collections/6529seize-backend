import {
  ATTACHMENT_ALLOWED_EXTENSIONS_BY_MIME_TYPE,
  ATTACHMENT_ALLOWED_MIME_TYPES,
  DROP_MEDIA_ALLOWED_EXTENSIONS_BY_MIME_TYPE,
  DROP_MEDIA_ALLOWED_MIME_TYPES
} from '@/api/media/media-mime-types';
import { createMediaPrepRequestSchema } from '@/api/media/media-uplodad.validators';
import * as fc from 'fast-check';

describe('media upload validators', () => {
  const dropMediaSchema = createMediaPrepRequestSchema({
    allowedMimeTypes: [...DROP_MEDIA_ALLOWED_MIME_TYPES],
    allowedExtensionsByMimeType: DROP_MEDIA_ALLOWED_EXTENSIONS_BY_MIME_TYPE
  });
  const attachmentSchema = createMediaPrepRequestSchema({
    allowedMimeTypes: [...ATTACHMENT_ALLOWED_MIME_TYPES],
    allowedExtensionsByMimeType: ATTACHMENT_ALLOWED_EXTENSIONS_BY_MIME_TYPE
  });
  const safeFileNameCharacters =
    'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-'.split(
      ''
    );
  const safeBaseName = fc
    .array(fc.constantFrom(...safeFileNameCharacters), {
      minLength: 1,
      maxLength: 33
    })
    .map((characters) => characters.join(''));
  const allKnownExtensions = Array.from(
    new Set(
      [
        ...Object.values(DROP_MEDIA_ALLOWED_EXTENSIONS_BY_MIME_TYPE).flat(),
        ...Object.values(ATTACHMENT_ALLOWED_EXTENSIONS_BY_MIME_TYPE).flat(),
        '.json',
        '.txt',
        '.exe'
      ].map((extension) => extension.toLowerCase())
    )
  );

  function allowedPairs(
    allowedExtensionsByMimeType: Record<string, readonly string[]>
  ): { contentType: string; extension: string }[] {
    return Object.entries(allowedExtensionsByMimeType).flatMap(
      ([contentType, extensions]) =>
        extensions.map((extension) => ({ contentType, extension }))
    );
  }

  function validateMedia(
    schema: typeof dropMediaSchema,
    contentType: string,
    fileName: string
  ) {
    return schema.validate({
      author: 'profile-id',
      content_type: contentType,
      file_name: fileName
    });
  }

  it('allows configured drop media MIME and extension pairs', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          ...allowedPairs(DROP_MEDIA_ALLOWED_EXTENSIONS_BY_MIME_TYPE)
        ),
        safeBaseName,
        ({ contentType, extension }, baseName) => {
          const { error } = validateMedia(
            dropMediaSchema,
            contentType,
            `${baseName}${extension}`
          );

          expect(error).toBeUndefined();
        }
      )
    );
  });

  it('rejects mismatched drop media MIME and extension pairs', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          ...allowedPairs(DROP_MEDIA_ALLOWED_EXTENSIONS_BY_MIME_TYPE)
        ),
        fc.constantFrom(...allKnownExtensions),
        safeBaseName,
        ({ contentType }, extension, baseName) => {
          fc.pre(
            !DROP_MEDIA_ALLOWED_EXTENSIONS_BY_MIME_TYPE[
              contentType as keyof typeof DROP_MEDIA_ALLOWED_EXTENSIONS_BY_MIME_TYPE
            ].includes(extension)
          );

          const { error } = validateMedia(
            dropMediaSchema,
            contentType,
            `${baseName}${extension}`
          );

          expect(error).toBeDefined();
        }
      )
    );
  });

  it('allows configured attachment MIME and extension pairs', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          ...allowedPairs(ATTACHMENT_ALLOWED_EXTENSIONS_BY_MIME_TYPE)
        ),
        safeBaseName,
        ({ contentType, extension }, baseName) => {
          const { error } = validateMedia(
            attachmentSchema,
            contentType,
            `${baseName}${extension}`
          );

          expect(error).toBeUndefined();
        }
      )
    );
  });

  it('rejects mismatched attachment MIME and extension pairs', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          ...allowedPairs(ATTACHMENT_ALLOWED_EXTENSIONS_BY_MIME_TYPE)
        ),
        fc.constantFrom(...allKnownExtensions),
        safeBaseName,
        ({ contentType }, extension, baseName) => {
          fc.pre(
            !ATTACHMENT_ALLOWED_EXTENSIONS_BY_MIME_TYPE[
              contentType as keyof typeof ATTACHMENT_ALLOWED_EXTENSIONS_BY_MIME_TYPE
            ].includes(extension)
          );

          const { error } = validateMedia(
            attachmentSchema,
            contentType,
            `${baseName}${extension}`
          );

          expect(error).toBeDefined();
        }
      )
    );
  });

  it.each([
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
    const { error } = dropMediaSchema.validate({
      author: 'profile-id',
      content_type: contentType,
      file_name: fileName
    });

    expect(error).toBeUndefined();
  });

  it('rejects unsupported drop media content types', () => {
    const { error } = dropMediaSchema.validate({
      author: 'profile-id',
      content_type: 'application/json',
      file_name: 'upload.json'
    });

    expect(error).toBeDefined();
  });

  it.each([
    ['application/pdf', 'upload.pdf'],
    ['text/csv', 'upload.csv']
  ])(
    'rejects attachment content type from drop media %s',
    (contentType, fileName) => {
      const { error } = dropMediaSchema.validate({
        author: 'profile-id',
        content_type: contentType,
        file_name: fileName
      });

      expect(error).toBeDefined();
    }
  );

  it.each([
    ['image/webp', 'upload.png'],
    ['image/png', '../upload.png'],
    ['image/png', ' folder/upload.png'],
    ['image/png', 'upload.png ']
  ])('rejects drop media %s file name %s', (contentType, fileName) => {
    const { error } = dropMediaSchema.validate({
      author: 'profile-id',
      content_type: contentType,
      file_name: fileName
    });

    expect(error).toBeDefined();
  });

  it.each([
    ['application/pdf', 'upload.pdf'],
    ['text/csv', 'upload.csv']
  ])('allows attachment %s file %s', (contentType, fileName) => {
    const { error } = attachmentSchema.validate({
      author: 'profile-id',
      content_type: contentType,
      file_name: fileName
    });

    expect(error).toBeUndefined();
  });

  it.each([
    ['application/pdf', 'upload.exe'],
    ['application/pdf', 'upload.pdf.exe'],
    ['application/pdf', 'upload.exe.pdf'],
    ['text/csv', 'upload.pdf']
  ])('rejects attachment %s file name %s', (contentType, fileName) => {
    const { error } = attachmentSchema.validate({
      author: 'profile-id',
      content_type: contentType,
      file_name: fileName
    });

    expect(error).toBeDefined();
  });

  it('rejects unsupported attachment content types', () => {
    const { error } = attachmentSchema.validate({
      author: 'profile-id',
      content_type: 'application/json',
      file_name: 'upload.json'
    });

    expect(error).toBeDefined();
  });
});
