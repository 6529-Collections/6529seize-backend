import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { Context } from 'aws-lambda';
import sharp from 'sharp';
import { Upload } from '@aws-sdk/lib-storage';
import {
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
jest.mock('@aws-sdk/client-s3', () => ({
  GetObjectCommand: jest.fn(),
  S3Client: jest.fn(() => ({
    send: jest.fn(async () => ({
      Body:
        mockSource ??
        Readable.from([mockInput.subarray(0, 8), mockInput.subarray(8)]),
      ContentType: mockContentType,
      ContentLength: mockContentLength
    }))
  }))
}));
jest.mock('@aws-sdk/lib-storage', () => ({
  Upload: jest.fn(({ params }: { params: { Body: Readable } }) => ({
    done: async () => {
      if (mockUploadError) throw mockUploadError;
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
