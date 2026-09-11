import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { Context } from 'aws-lambda';
import sharp from 'sharp';

let mockInput: Buffer;
let mockContentType: string;
let mockUploaded: Buffer;
jest.mock('@aws-sdk/client-s3', () => ({
  GetObjectCommand: jest.fn(),
  S3Client: jest.fn(() => ({
    send: jest.fn(async () => ({
      Body: Readable.from([mockInput.subarray(0, 8), mockInput.subarray(8)]),
      ContentType: mockContentType
    }))
  }))
}));
jest.mock('@aws-sdk/lib-storage', () => ({
  Upload: jest.fn(({ params }: { params: { Body: Readable } }) => ({
    done: async () => {
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
