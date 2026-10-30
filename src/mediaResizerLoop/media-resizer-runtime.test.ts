import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { Context } from 'aws-lambda';
import sharp from 'sharp';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { Logger } from '@/logging';
import {
  prepareUploadImagePreviews,
  previewObjectKey
} from '@/media/upload-image-previews';
import {
  classifyResizeDecoderError,
  assertDecodedWorkBudget,
  MAX_SOURCE_BYTES,
  UnprocessableResizeInput
} from '@/mediaResizerLoop/resize-resource-safety';

let mockInput: Buffer;
let mockContentType: string;
let mockUploaded: Buffer;
let mockSource: Readable | undefined;
let mockContentLength: number | undefined;
let mockUploadError: Error | undefined;
let mockDecoderError: Error | undefined;
let mockGetObjectError: Error | undefined;
let mockHeadError: Error | undefined;
let mockPutError: Error | undefined;
let mockRevision: string;
const mockRejections = new Set<string>();
const mockReportUnsupported = jest.fn();
jest.mock('@/mediaResizerLoop/unsupported-resize-report', () => ({
  ...jest.requireActual('@/mediaResizerLoop/unsupported-resize-report'),
  reportUnsupportedResizeOnce: (...args: unknown[]) =>
    mockReportUnsupported(...args)
}));
jest.mock('@aws-sdk/client-s3', () => ({
  GetObjectCommand: jest.fn(),
  HeadObjectCommand: jest.fn((input) => ({ kind: 'head', input })),
  PutObjectCommand: jest.fn((input) => ({ kind: 'put', input })),
  S3Client: jest.fn(() => ({
    send: jest.fn(
      async (command: { kind?: string; input?: { Key: string } }) => {
        if (command.kind === 'head') {
          if (mockHeadError) throw mockHeadError;
          if (!mockRejections.has(command.input!.Key)) {
            throw Object.assign(new Error('missing'), {
              name: 'NotFound',
              $metadata: { httpStatusCode: 404 }
            });
          }
          return { Metadata: { 'rejection-code': 'HEIC_DECODE_FAILED' } };
        }
        if (command.kind === 'put') {
          if (mockPutError) throw mockPutError;
          if (mockRejections.has(command.input!.Key))
            throw { $metadata: { httpStatusCode: 412 } };
          mockRejections.add(command.input!.Key);
          return {};
        }
        if (mockGetObjectError) throw mockGetObjectError;
        return {
          Body:
            mockSource ??
            Readable.from([mockInput.subarray(0, 8), mockInput.subarray(8)]),
          ContentType: mockContentType,
          ETag: mockRevision,
          ContentLength: mockContentLength
        };
      }
    )
  }))
}));
jest.mock('@aws-sdk/lib-storage', () => ({
  Upload: jest.fn(({ params }: { params: { Body: Readable } }) => ({
    done: async () => {
      if (mockUploadError) throw mockUploadError;
      if (mockDecoderError) {
        // Native Sharp failures emit directly, without destroy(error) setting
        // Readable.errored. Preserve that behavior in the regression fixture.
        params.Body._read = () => {
          params.Body.emit('error', mockDecoderError);
        };
      }
      const chunks: Buffer[] = [];
      for await (const chunk of params.Body) chunks.push(chunk);
      mockUploaded = Buffer.concat(chunks);
    }
  }))
}));
jest.mock('@/sentry.context', () => ({
  wrapLambdaHandler: (handler: unknown) => handler
}));

const previousBucket = process.env.BUCKET;
process.env.BUCKET = 'synthetic-bucket';
import { handler } from '@/mediaResizerLoop';
afterAll(() => {
  if (previousBucket === undefined) delete process.env.BUCKET;
  else process.env.BUCKET = previousBucket;
});

beforeEach(() => {
  jest.clearAllMocks();
  const memoryUsage = process.memoryUsage;
  jest.spyOn(process, 'memoryUsage').mockImplementation(
    Object.assign(() => ({ ...memoryUsage(), rss: 64 * 1024 * 1024 }), {
      rss: memoryUsage.rss
    })
  );
  mockInput = readFileSync(
    join(__dirname, '../../scripts/media-fixtures/jpeg')
  );
  mockContentType = 'image/jpeg';
  mockContentLength = undefined;
  mockSource = undefined;
  mockUploadError = undefined;
  mockDecoderError = undefined;
  mockGetObjectError = undefined;
  mockHeadError = undefined;
  mockPutError = undefined;
  mockRevision = 'synthetic-etag';
  mockRejections.clear();
});
afterEach(() => jest.restoreAllMocks());

function resize() {
  return handler(
    { queryStringParameters: { path: 'synthetic/6x6_max/fixture' } },
    {} as Context,
    () => undefined
  );
}

it('returns 404 without an operational error for a missing source object', async () => {
  mockGetObjectError = Object.assign(
    new Error('The specified key does not exist.'),
    {
      name: 'NoSuchKey',
      $metadata: { httpStatusCode: 404 }
    }
  );
  const errorLog = jest.spyOn(Logger.get('MEDIA_RESIZER_LOOP'), 'error');
  const infoLog = jest.spyOn(Logger.get('MEDIA_RESIZER_LOOP'), 'info');

  expect((await resize()).statusCode).toBe(404);
  expect(errorLog).not.toHaveBeenCalled();
  expect(infoLog).toHaveBeenCalledWith(
    '[synthetic/6x6_max/fixture] S3 origin file not found'
  );
  expect(Upload).not.toHaveBeenCalled();
});

it.each([
  ['AccessDenied', 403],
  ['ServiceUnavailable', 503],
  ['NoSuchKey', 403],
  ['NoSuchKey', 200]
])(
  'propagates %s source retrieval errors with HTTP %i',
  async (name, status) => {
    mockGetObjectError = Object.assign(new Error(name), {
      name,
      $metadata: { httpStatusCode: status }
    });
    const errorLog = jest.spyOn(Logger.get('MEDIA_RESIZER_LOOP'), 'error');

    await expect(resize()).rejects.toBe(mockGetObjectError);
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(Upload).not.toHaveBeenCalled();
  }
);

it('does not suppress a missing-key error without an HTTP status', async () => {
  mockGetObjectError = Object.assign(new Error('missing status'), {
    name: 'NoSuchKey'
  });
  const errorLog = jest.spyOn(Logger.get('MEDIA_RESIZER_LOOP'), 'error');

  await expect(resize()).rejects.toBe(mockGetObjectError);
  expect(errorLog).toHaveBeenCalledTimes(1);
});

it('does not treat an upload NoSuchKey as a missing source', async () => {
  mockUploadError = Object.assign(new Error('upload failed'), {
    name: 'NoSuchKey',
    $metadata: { httpStatusCode: 404 }
  });
  const errorLog = jest.spyOn(Logger.get('MEDIA_RESIZER_LOOP'), 'error');

  await expect(resize()).rejects.toBe(mockUploadError);
  expect(errorLog).toHaveBeenCalledTimes(1);
});

it.each(['jpeg', 'png', 'gif'])(
  'finishes the %s streaming upload before returning the redirect',
  async (format) => {
    mockInput = readFileSync(
      join(__dirname, '../../scripts/media-fixtures', format)
    );
    mockContentType = `image/${format}`;
    const result = await handler(
      { queryStringParameters: { path: 'synthetic/6x6_max/fixture' } },
      {} as Context,
      () => undefined
    );
    expect(result.statusCode).toBe(302);
    expect(Upload).toHaveBeenCalledWith(
      expect.objectContaining({ queueSize: 1 })
    );
    const meta = await sharp(mockUploaded, { animated: true }).metadata();
    expect(meta.width).toBe(format === 'jpeg' ? 3 : 6);
    expect(format === 'gif' ? meta.pageHeight : meta.height).toBe(
      format === 'jpeg' ? 6 : 3
    );
    expect(meta.exif).toBeUndefined();
    if (format === 'gif')
      expect(meta).toMatchObject({ pages: 2, delay: [80, 160], loop: 2 });
  }
);

it('preserves the exact ordinary JPEG and PNG output bytes', async () => {
  for (const format of ['jpeg', 'png']) {
    mockInput = readFileSync(
      join(__dirname, '../../scripts/media-fixtures', format)
    );
    mockContentType = `image/${format}`;
    const expected = await sharp(mockInput, {
      failOn: 'none',
      limitInputPixels: 1e9
    })
      .resize(6, 6, { fit: 'inside', withoutEnlargement: true })
      .rotate()
      .toBuffer();
    await resize();
    expect(mockUploaded.equals(expected)).toBe(true);
  }
});

it('creates a preview of a large baseline JPEG using decoder downsampling', async () => {
  mockInput = await sharp({
    create: { width: 9000, height: 6000, channels: 3, background: '#567888' }
  })
    .jpeg()
    .toBuffer();
  const result = await handler(
    { queryStringParameters: { path: 'synthetic/AUTOx1080/large.jpeg' } },
    {} as Context,
    () => undefined
  );
  expect(result.statusCode).toBe(302);
  expect(await sharp(mockUploaded).metadata()).toMatchObject({
    width: 1620,
    height: 1080,
    format: 'jpeg'
  });
});

it('uses a bounded still preview when the entire GIF animation exceeds the budget', async () => {
  const frames = Buffer.alloc(1024 * 1024 * 3 * 33);
  for (let frame = 0; frame < 33; frame++) {
    frames.fill(
      frame * 7,
      frame * 1024 * 1024 * 3,
      (frame + 1) * 1024 * 1024 * 3
    );
  }
  mockInput = await sharp(frames, {
    raw: { width: 1024, height: 1024 * 33, channels: 3, pageHeight: 1024 }
  })
    .gif({ delay: 100 })
    .toBuffer();
  mockContentType = 'image/gif';
  expect((await resize()).statusCode).toBe(302);
  expect(
    await sharp(mockUploaded, { animated: true }).metadata()
  ).toMatchObject({
    width: 6,
    height: 6,
    pages: 1,
    format: 'gif'
  });
});

it('keeps progressive JPEG, unsupported codec and near-original requests within the full budget', async () => {
  const base = await sharp(mockInput).metadata();
  const large = { ...base, width: 16000, height: 14000 };
  const target = { width: null, height: 1080 };
  expect(() => assertDecodedWorkBudget(large, false, target)).not.toThrow();
  for (const metadata of [
    { ...large, isProgressive: true },
    { ...large, format: 'png' as const },
    { ...large, depth: 'ushort' as const }
  ]) {
    expect(() => assertDecodedWorkBudget(metadata, false, target)).toThrow(
      UnprocessableResizeInput
    );
  }
  expect(() =>
    assertDecodedWorkBudget(large, false, { width: null, height: 10000 })
  ).toThrow(UnprocessableResizeInput);
});

it('accounts for JPEG shrink rounding boundaries and rotated dimensions', async () => {
  const base = await sharp(mockInput).metadata();
  const large = { ...base, width: 16384, height: 12288 };
  // At an exact 2x shrink Sharp falls back to a full-size decode.
  expect(() =>
    assertDecodedWorkBudget(large, false, { width: 8192, height: null })
  ).toThrow(UnprocessableResizeInput);
  // A portrait rotation changes the axis constrained by AUTOxheight.
  expect(() =>
    assertDecodedWorkBudget(
      { ...base, width: 24000, height: 2000, orientation: 6 },
      false,
      { width: null, height: 2000 }
    )
  ).not.toThrow();
  expect(() =>
    assertDecodedWorkBudget(
      { ...base, width: 24000, height: 2000, orientation: 6 },
      false,
      { width: 2000, height: null }
    )
  ).toThrow(UnprocessableResizeInput);
});

it('conservatively budgets both axes when their shrink ratios differ', async () => {
  const base = await sharp(mockInput).metadata();
  // Ratios 10 and 2: inside could shrink by 8, but cover/outside cannot. The
  // common estimate deliberately keeps the larger full-decode budget here.
  const large = { ...base, width: 16000, height: 12000 };
  expect(() =>
    assertDecodedWorkBudget(large, false, { width: 1600, height: 6000 })
  ).toThrow(UnprocessableResizeInput);
  // Both axes safely support a decoder shrink even for the stricter fit.
  expect(() =>
    assertDecodedWorkBudget(large, false, { width: 1600, height: 2400 })
  ).not.toThrow();
});

it('rejects malformed image bytes without attempting an upload', async () => {
  mockInput = Buffer.from('not an image');
  const result = await resize();
  expect(result.statusCode).toBe(422);
  expect(JSON.parse(result.body)).toEqual({
    error: 'Image cannot be resized',
    code: 'INVALID_IMAGE'
  });
  expect(Upload).not.toHaveBeenCalled();
});

it('rejects oversized decoded dimensions from real metadata before conversion/upload', async () => {
  mockInput = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="8193" height="4096"><rect width="1" height="1"/></svg>'
  );
  mockContentType = 'image/svg+xml';
  const result = await resize();
  expect(result.statusCode).toBe(422);
  expect(JSON.parse(result.body).code).toBe('DECODED_IMAGE_TOO_LARGE');
  expect(Upload).not.toHaveBeenCalled();
});

it('does not upscale physical-unit SVG input when a larger raster is requested', async () => {
  mockInput = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1in" height="0.5in"><rect width="72" height="36" fill="red"/></svg>'
  );
  mockContentType = 'image/svg+xml';
  const input = await sharp(mockInput).metadata();
  expect(input).toMatchObject({ width: 72, height: 36 });
  const result = await handler(
    { queryStringParameters: { path: 'synthetic/20000x20000_max/fixture' } },
    {} as Context,
    () => undefined
  );
  expect(result.statusCode).toBe(302);
  expect(await sharp(mockUploaded).metadata()).toMatchObject({
    format: 'png',
    width: input.width,
    height: input.height
  });
});

it('rejects a known oversized source before reading any source bytes', async () => {
  const read = jest.fn();
  mockSource = new Readable({ read });
  mockContentLength = MAX_SOURCE_BYTES + 1;
  const result = await resize();
  expect(result.statusCode).toBe(422);
  expect(JSON.parse(result.body).code).toBe('SOURCE_TOO_LARGE');
  expect(read).not.toHaveBeenCalled();
  expect(mockSource.destroyed).toBe(true);
  expect(Upload).not.toHaveBeenCalled();
});

it.each(['oversized source', 'temporary directory failure'])(
  'handles an asynchronous source-destroy error after %s',
  async (failure) => {
    const sourceCloseError = new Error('synthetic socket close failure');
    const directoryError = new Error('synthetic temporary disk failure');
    mockSource = new Readable({
      read: jest.fn(),
      destroy(_error, callback) {
        callback(sourceCloseError);
      }
    });
    if (failure === 'oversized source') {
      mockContentLength = MAX_SOURCE_BYTES + 1;
      expect((await resize()).statusCode).toBe(422);
    } else {
      jest.spyOn(fs, 'mkdtemp').mockRejectedValueOnce(directoryError);
      await expect(resize()).rejects.toBe(directoryError);
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mockSource.destroyed).toBe(true);
    expect(Upload).not.toHaveBeenCalled();
  }
);

it('preserves a source failure that occurs while the temporary directory is being created', async () => {
  const sourceError = new Error('synthetic early S3 failure');
  const makeDirectory = fs.mkdtemp;
  mockSource = new Readable({ read: jest.fn() });
  const directories = jest
    .spyOn(fs, 'mkdtemp')
    .mockImplementationOnce(async (prefix) => {
      mockSource!.destroy(sourceError);
      await new Promise<void>((resolve) => setImmediate(resolve));
      return makeDirectory(prefix);
    });
  await expect(resize()).rejects.toBe(sourceError);
  expect(Upload).not.toHaveBeenCalled();
  const directory = await directories.mock.results[0].value;
  await expect(fs.access(directory)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('stops an unknown-length source at the byte budget and removes its temporary file', async () => {
  const directories = jest.spyOn(fs, 'mkdtemp');
  let chunksRead = 0;
  const chunk = Buffer.alloc(1024 * 1024);
  mockSource = Readable.from(
    (function* () {
      for (let index = 0; index < 300; index++) {
        chunksRead++;
        yield chunk;
      }
    })()
  );
  const result = await resize();
  expect(result.statusCode).toBe(422);
  expect(JSON.parse(result.body).code).toBe('SOURCE_TOO_LARGE');
  expect(chunksRead).toBeLessThan(300);
  expect(mockSource.destroyed).toBe(true);
  expect(Upload).not.toHaveBeenCalled();
  const directory = await directories.mock.results[0].value;
  await expect(fs.access(directory)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('removes temporary files after successful animated conversion', async () => {
  const directories = jest.spyOn(fs, 'mkdtemp');
  mockInput = readFileSync(join(__dirname, '../../scripts/media-fixtures/gif'));
  mockContentType = 'image/gif';
  await resize();
  const directory = await directories.mock.results[0].value;
  await expect(fs.access(directory)).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each(['source', 'upload'])(
  'preserves %s infrastructure errors and removes temporary files',
  async (failure) => {
    const directories = jest.spyOn(fs, 'mkdtemp');
    const error = new Error('synthetic connection failure');
    if (failure === 'source') {
      mockSource = new Readable({
        read() {
          this.destroy(error);
        }
      });
    } else {
      mockUploadError = error;
    }
    await expect(resize()).rejects.toBe(error);
    const directory = await directories.mock.results[0].value;
    await expect(fs.access(directory)).rejects.toMatchObject({
      code: 'ENOENT'
    });
  }
);

it.each(['source', 'upload', 'invalid input', 'success'])(
  'preserves the primary %s outcome when temporary cleanup fails',
  async (outcome) => {
    const primaryError = new Error('synthetic processing failure');
    const cleanupError = new Error('synthetic cleanup failure');
    const remove = fs.rm;
    // Remove this fixture's own directory before simulating an rm rejection,
    // so the regression itself does not leave temporary files behind.
    jest.spyOn(fs, 'rm').mockImplementationOnce(async (path, options) => {
      await remove(path, options);
      throw cleanupError;
    });
    if (outcome === 'source') {
      mockSource = new Readable({
        read() {
          this.destroy(primaryError);
        }
      });
    } else if (outcome === 'upload') {
      mockUploadError = primaryError;
    } else if (outcome === 'invalid input') {
      mockInput = Buffer.from('not an image');
    }
    if (outcome === 'invalid input') {
      const result = await resize();
      expect(result.statusCode).toBe(422);
      expect(JSON.parse(result.body).code).toBe('INVALID_IMAGE');
    } else {
      await expect(resize()).rejects.toBe(
        outcome === 'success' ? cleanupError : primaryError
      );
    }
  }
);

it('propagates an unmatched native-codec error instead of caching a 422', async () => {
  mockUploadError = new Error(
    'VipsForeignLoad: synthetic unclassified failure'
  );
  await expect(resize()).rejects.toBe(mockUploadError);
});

it('counts animation frames and higher sample depths in decoded admission', async () => {
  const base = await sharp(mockInput).metadata();
  const admitted = {
    ...base,
    width: 8192,
    height: 4096,
    channels: 4 as const,
    depth: 'uchar' as const
  };
  expect(() => assertDecodedWorkBudget(admitted, false)).not.toThrow();
  expect(() =>
    assertDecodedWorkBudget({ ...admitted, width: 8193 }, false)
  ).toThrow(UnprocessableResizeInput);
  expect(() =>
    assertDecodedWorkBudget({ ...admitted, depth: 'ushort' }, false)
  ).toThrow(UnprocessableResizeInput);
  const animation = {
    ...admitted,
    width: 1024,
    height: 33792,
    pageHeight: 1024,
    pages: 33
  };
  expect(() => assertDecodedWorkBudget(animation, true)).toThrow(
    UnprocessableResizeInput
  );
  expect(() =>
    assertDecodedWorkBudget({ ...animation, height: 32768, pages: 32 }, true)
  ).not.toThrow();
});

it('uses a conservative frame-height fallback while still charging every animated page', async () => {
  const metadata = await sharp(mockInput).metadata();
  const animation = {
    ...metadata,
    width: 4096,
    height: 4096,
    pages: 2,
    channels: 4 as const,
    depth: 'uchar' as const
  };
  expect(() => assertDecodedWorkBudget(animation, true)).not.toThrow();
  expect(() =>
    assertDecodedWorkBudget({ ...animation, height: 4097 }, true)
  ).toThrow(UnprocessableResizeInput);
});

const unsupportedHeif =
  'heif: Error while loading plugin: Support for this compression format has not been built in (11.6003)';

it('returns 422 and reports a known unsupported decoder failure even when MIME says WebP', async () => {
  const directories = jest.spyOn(fs, 'mkdtemp');
  mockContentType = 'image/webp';
  mockDecoderError = new Error(
    `/tmp/synthetic/source: bad seek to 96405\n${unsupportedHeif}`
  );
  const result = await resize();
  expect(result.statusCode).toBe(422);
  expect(JSON.parse(result.body).code).toBe('UNSUPPORTED_CODEC');
  expect(mockReportUnsupported).toHaveBeenCalledWith(
    expect.anything(),
    'synthetic-bucket',
    'synthetic/fixture',
    'synthetic-etag'
  );
  const directory = await directories.mock.results[0].value;
  await expect(fs.access(directory)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('does not mistake an upload error with decoder-like text for an input rejection', async () => {
  mockUploadError = new Error(unsupportedHeif);
  await expect(resize()).rejects.toBe(mockUploadError);
  expect(mockReportUnsupported).not.toHaveBeenCalled();
});

it('classifies the exact HEIF capability error without swallowing other plugin or decoder failures', () => {
  expect(classifyResizeDecoderError(new Error(unsupportedHeif))).toMatchObject({
    code: 'UNSUPPORTED_CODEC'
  });
  for (const message of [
    'heif: corrupted input',
    'heif: Error while loading plugin: Permission denied',
    'VipsForeignLoad: unknown failure'
  ]) {
    const error = new Error(message);
    expect(classifyResizeDecoderError(error)).toBe(error);
  }
});

it('serves a versioned no-op GIF unchanged, using the original S3 key and GIF content type', async () => {
  mockInput = readFileSync(join(__dirname, '../../scripts/media-fixtures/gif'));
  mockContentType = 'application/octet-stream';
  const result = await handler(
    { queryStringParameters: { path: 'synthetic/AUTOx800_gifv2/fixture.gif' } },
    {} as Context,
    () => undefined
  );
  expect(result.statusCode).toBe(302);
  expect(GetObjectCommand).toHaveBeenCalledWith(
    expect.objectContaining({ Key: 'synthetic/fixture.gif' })
  );
  expect(Upload).toHaveBeenCalledWith(
    expect.objectContaining({
      params: expect.objectContaining({
        Key: 'synthetic/AUTOx800_gifv2/fixture.gif',
        ContentType: 'image/gif'
      })
    })
  );
  expect(mockUploaded).toEqual(mockInput);
});

it('does not silently publish a still or mislabeled file under the GIF v2 contract', async () => {
  const result = await handler(
    { queryStringParameters: { path: 'synthetic/AUTOx800_gifv2/fixture.gif' } },
    {} as Context,
    () => undefined
  );
  expect(result.statusCode).toBe(422);
  expect(Upload).not.toHaveBeenCalled();
});

it.each(['AUTOxAUTO_gifv2', '0x800_gifv2', 'AUTOx800oops_gifv2'])(
  'rejects invalid animation dimensions %s before fetching',
  async (option) => {
    const result = await handler(
      { queryStringParameters: { path: `synthetic/${option}/fixture.gif` } },
      {} as Context,
      () => undefined
    );
    expect(result.statusCode).toBe(404);
    expect(GetObjectCommand).not.toHaveBeenCalled();
  }
);

it.each([false, true])(
  'cleans re-encoded GIF files after upload (failure=%s)',
  async (failUpload) => {
    const directories = jest.spyOn(fs, 'mkdtemp');
    mockInput = readFileSync(
      join(__dirname, '../../scripts/media-fixtures/gif')
    );
    mockContentType = 'image/gif';
    if (failUpload) mockUploadError = new Error('synthetic upload failure');
    const result = handler(
      { queryStringParameters: { path: 'synthetic/AUTOx2_gifv2/fixture.gif' } },
      { getRemainingTimeInMillis: () => 30000 } as Context,
      () => undefined
    );
    if (failUpload) {
      await expect(result).rejects.toBe(mockUploadError);
    } else {
      expect((await result).statusCode).toBe(302);
      expect(mockUploaded).not.toEqual(mockInput);
      expect(
        await sharp(mockUploaded, { animated: true }).metadata()
      ).toMatchObject({
        pageHeight: 2,
        pages: 2,
        delay: [80, 160],
        loop: 2
      });
    }
    expect(Upload).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          Key: 'synthetic/AUTOx2_gifv2/fixture.gif',
          ContentType: 'image/gif'
        })
      })
    );
    const directory = await directories.mock.results[0].value;
    await expect(fs.access(directory)).rejects.toMatchObject({
      code: 'ENOENT'
    });
  }
);

it('uses Lambda remaining time after source spooling before starting GIF work', async () => {
  const directories = jest.spyOn(fs, 'mkdtemp');
  mockInput = readFileSync(join(__dirname, '../../scripts/media-fixtures/gif'));
  // Operational failures propagate rather than returning a cacheable 422.
  await expect(
    handler(
      { queryStringParameters: { path: 'synthetic/AUTOx2_gifv2/fixture.gif' } },
      { getRemainingTimeInMillis: () => 2500 } as Context,
      () => undefined
    )
  ).rejects.toThrow('GIF_PREVIEW_DEADLINE_EXCEEDED');
  expect(Upload).not.toHaveBeenCalled();
  expect(mockReportUnsupported).not.toHaveBeenCalled();
  const directory = await directories.mock.results[0].value;
  await expect(fs.access(directory)).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each([
  ['AUTOx800_gifv2', 1999],
  ['AUTOx2_gifv2', 1999],
  ['AUTOx800_gifv2', 2000],
  ['AUTOx2_gifv2', 2000]
])(
  'checks the upload reserve after preparing %s with %i ms left',
  async (option, remainingTimeMs) => {
    const directories = jest.spyOn(fs, 'mkdtemp');
    mockInput = readFileSync(
      join(__dirname, '../../scripts/media-fixtures/gif')
    );
    const getRemainingTimeInMillis = jest
      .fn()
      .mockReturnValueOnce(30000)
      .mockReturnValue(remainingTimeMs);
    const result = handler(
      { queryStringParameters: { path: `synthetic/${option}/fixture.gif` } },
      { getRemainingTimeInMillis } as unknown as Context,
      () => undefined
    );
    if (remainingTimeMs < 2000) {
      await expect(result).rejects.toThrow('GIF_PREVIEW_DEADLINE_EXCEEDED');
      expect(Upload).not.toHaveBeenCalled();
    } else {
      expect((await result).statusCode).toBe(302);
      expect(Upload).toHaveBeenCalledTimes(1);
      if (option === 'AUTOx800_gifv2') {
        expect(mockUploaded).toEqual(mockInput);
      } else {
        expect(mockUploaded).not.toEqual(mockInput);
      }
    }
    expect(getRemainingTimeInMillis).toHaveBeenCalledTimes(2);
    expect(mockReportUnsupported).not.toHaveBeenCalled();
    const directory = await directories.mock.results[0].value;
    await expect(fs.access(directory)).rejects.toMatchObject({
      code: 'ENOENT'
    });
  }
);

it('returns a cacheable 422 for the AUTO sequential work limit', async () => {
  const pixels = Buffer.alloc(2 * 2 * 120 * 4, 255);
  mockInput = await sharp(pixels, {
    raw: { width: 2, height: 240, channels: 4, pageHeight: 2 }
  })
    .gif({ keepDuplicateFrames: true, delay: Array(120).fill(100) })
    .toBuffer();
  mockInput.writeUInt16LE(2048, 6);
  mockInput.writeUInt16LE(2048, 8);
  const result = await handler(
    { queryStringParameters: { path: 'synthetic/AUTOx600_gifv2/fixture.gif' } },
    {} as Context,
    () => undefined
  );
  expect(result.statusCode).toBe(422);
  expect(result.headers?.['Cache-Control']).toBe('public, max-age=300');
  expect(JSON.parse(result.body!)).toMatchObject({
    code: 'DECODED_IMAGE_TOO_LARGE'
  });
  expect(Upload).not.toHaveBeenCalled();
});

it('returns a cacheable 422 for a native GIF per-frame pixel rejection', async () => {
  mockInput = await sharp({
    create: { width: 4096, height: 2049, channels: 3, background: 'red' }
  })
    .gif()
    .toBuffer();
  await expect(
    sharp(mockInput, { limitInputPixels: 8 * 1024 * 1024 }).metadata()
  ).rejects.toThrow('Input image exceeds pixel limit');
  const result = await handler(
    { queryStringParameters: { path: 'synthetic/AUTOx600_gifv2/fixture.gif' } },
    {} as Context,
    () => undefined
  );
  expect(result.statusCode).toBe(422);
  expect(result.headers?.['Cache-Control']).toBe('public, max-age=300');
  expect(Upload).not.toHaveBeenCalled();
});

function useHeicFixture(corrupt = false) {
  mockInput = readFileSync(
    join(__dirname, '../../scripts/media-fixtures/heic')
  );
  mockContentType = 'image/jpeg';
  if (corrupt) {
    // Keep HEIF metadata valid and destroy only the encoded pixel payload.
    for (let offset = 0; offset < mockInput.length; ) {
      const length = mockInput.readUInt32BE(offset);
      if (mockInput.toString('ascii', offset + 4, offset + 8) === 'mdat') {
        mockInput.fill(0, offset + 8, offset + length);
        break;
      }
      offset += length;
    }
  }
}

it('resizes mislabeled HEIC as JPEG without changing its source or destination key', async () => {
  useHeicFixture();
  const original = Buffer.from(mockInput);
  const directories = jest.spyOn(fs, 'mkdtemp');
  const result = await resize();
  expect(result.statusCode).toBe(302);
  expect(await sharp(mockUploaded).metadata()).toMatchObject({
    format: 'jpeg',
    width: 6,
    height: 6
  });
  expect(Upload).toHaveBeenCalledWith(
    expect.objectContaining({
      params: expect.objectContaining({
        Key: 'synthetic/6x6_max/fixture',
        ContentType: 'image/jpeg'
      })
    })
  );
  expect(mockInput).toEqual(original);
  expect(PutObjectCommand).not.toHaveBeenCalled();
  await expect(
    fs.access(await directories.mock.results[0].value)
  ).rejects.toMatchObject({ code: 'ENOENT' });
});

it('caches a confirmed HEIC decoder rejection across sizes and retries a new source revision', async () => {
  useHeicFixture(true);
  const first = await resize();
  expect(first.statusCode).toBe(422);
  expect(JSON.parse(first.body).code).toBe('HEIC_DECODE_FAILED');
  expect(PutObjectCommand).toHaveBeenCalledTimes(1);
  expect(mockRejections.size).toBe(1);
  // A different resize option hits the same revision marker, without a worker.
  const exec = jest.spyOn(require('node:child_process'), 'execFile');
  const second = await handler(
    { queryStringParameters: { path: 'synthetic/AUTOx450/fixture' } },
    {} as Context,
    () => undefined
  );
  expect(second.statusCode).toBe(422);
  expect(exec).not.toHaveBeenCalled();
  expect(PutObjectCommand).toHaveBeenCalledTimes(1);
  expect(Upload).not.toHaveBeenCalled();
  useHeicFixture();
  mockRevision = 'replacement-etag';
  expect((await resize()).statusCode).toBe(302);
  expect(exec).toHaveBeenCalledTimes(1);
});

it.each(['lookup', 'marker write', 'upload'])(
  'preserves HEIC %s infrastructure failures',
  async (failure) => {
    useHeicFixture(failure === 'marker write');
    const error = new Error('synthetic HEIC infrastructure failure');
    if (failure === 'lookup') mockHeadError = error;
    if (failure === 'marker write') mockPutError = error;
    if (failure === 'upload') mockUploadError = error;
    await expect(resize()).rejects.toBe(error);
    expect(mockRejections.size).toBe(0);
  }
);

it('keeps a silently short S3 response operational before decoding or caching', async () => {
  useHeicFixture();
  mockContentLength = mockInput.length + 1;
  await expect(resize()).rejects.toThrow('RESIZE_SOURCE_LENGTH_MISMATCH');
  expect(HeadObjectCommand).not.toHaveBeenCalled();
  expect(Upload).not.toHaveBeenCalled();
  expect(PutObjectCommand).not.toHaveBeenCalled();
});

it.each([2500, 1999])(
  'does not cache a HEIC deadline failure with %i ms remaining',
  async (remaining) => {
    useHeicFixture();
    let calls = 0;
    const getRemainingTimeInMillis = () =>
      remaining === 2500 || calls++ > 0 ? remaining : 30000;
    await expect(
      handler(
        { queryStringParameters: { path: 'synthetic/6x6_max/fixture' } },
        { getRemainingTimeInMillis } as Context,
        () => undefined
      )
    ).rejects.toThrow('HEIC_CONVERSION_DEADLINE_EXCEEDED');
    expect(mockRejections.size).toBe(0);
    expect(PutObjectCommand).not.toHaveBeenCalled();
    expect(Upload).not.toHaveBeenCalled();
  }
);

it('returns a controlled rejection for PNG AUTOxAUTO when no whitelist is configured', async () => {
  mockInput = readFileSync(join(__dirname, '../../scripts/media-fixtures/png'));
  mockContentType = 'image/png';
  const errorLog = jest.spyOn(Logger.get('MEDIA_RESIZER_LOOP'), 'error');
  const response = await handler(
    { queryStringParameters: { path: 'synthetic/AUTOxAUTO/fixture.png' } },
    {} as Context,
    () => undefined
  );
  expect(response.statusCode).toBe(422);
  expect(errorLog).not.toHaveBeenCalled();
  expect(Upload).not.toHaveBeenCalled();
});

it.each(['jpeg', 'png', 'webp', 'gif'])(
  'produces byte-identical upload and on-demand legacy previews for %s',
  async (format) => {
    mockInput = readFileSync(
      join(__dirname, '../../scripts/media-fixtures', format)
    );
    mockContentType = `image/${format}`;
    const directory = await fs.mkdtemp(
      join(require('node:os').tmpdir(), 'preview-parity-')
    );
    try {
      const source = join(directory, 'source');
      await fs.writeFile(source, mockInput);
      const previews = await prepareUploadImagePreviews(
        source,
        mockContentType
      );
      for (const preview of previews) {
        expect(
          (
            await handler(
              {
                queryStringParameters: {
                  path: `synthetic/${preview.option}/fixture`
                }
              },
              {} as Context,
              () => undefined
            )
          ).statusCode
        ).toBe(302);
        expect(mockUploaded).toEqual(await fs.readFile(preview.path));
      }
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
);

it('inserts preview options next to the filename for both root and nested keys', () => {
  expect(previewObjectKey('image.png', 'AUTOx450')).toBe('AUTOx450/image.png');
  expect(previewObjectKey('drops/author/image.png', 'AUTOx1080')).toBe(
    'drops/author/AUTOx1080/image.png'
  );
});
