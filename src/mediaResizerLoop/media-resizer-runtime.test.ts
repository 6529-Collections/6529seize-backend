import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { Context } from 'aws-lambda';
import sharp from 'sharp';
import { Upload } from '@aws-sdk/lib-storage';
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
const mockReportUnsupported = jest.fn();
jest.mock('@/mediaResizerLoop/unsupported-resize-report', () => ({
  reportUnsupportedResizeOnce: (...args: unknown[]) =>
    mockReportUnsupported(...args)
}));
jest.mock('@aws-sdk/client-s3', () => ({
  GetObjectCommand: jest.fn(),
  S3Client: jest.fn(() => ({
    send: jest.fn(async () => ({
      Body:
        mockSource ??
        Readable.from([mockInput.subarray(0, 8), mockInput.subarray(8)]),
      ContentType: mockContentType,
      ETag: 'synthetic-etag',
      ContentLength: mockContentLength
    }))
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

import { handler } from '@/mediaResizerLoop';

beforeEach(() => {
  jest.clearAllMocks();
  mockInput = readFileSync(
    join(__dirname, '../../scripts/media-fixtures/jpeg')
  );
  mockContentType = 'image/jpeg';
  mockContentLength = undefined;
  mockSource = undefined;
  mockUploadError = undefined;
  mockDecoderError = undefined;
});
afterEach(() => jest.restoreAllMocks());

function resize() {
  return handler(
    { queryStringParameters: { path: 'synthetic/6x6_max/fixture' } },
    {} as Context,
    () => undefined
  );
}

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
    undefined,
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
