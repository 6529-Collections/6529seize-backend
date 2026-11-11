import childProcess from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import {
  isHeic,
  prepareHeicPreview,
  HEIC_DECODER_POLICY
} from '@/mediaResizerLoop/heic-preview';
import { UnprocessableResizeInput } from '@/mediaResizerLoop/resize-resource-safety';

let directory: string;
let inputPath: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'heic-preview-test-'));
  inputPath = join(directory, 'mislabeled.jpg');
  await writeFile(
    inputPath,
    await readFile(join(__dirname, '../../scripts/media-fixtures/heic'))
  );
});
afterEach(async () => {
  jest.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

it('routes detected HEVC independently of the filename, without treating AVIF as HEIC', async () => {
  const metadata = await sharp(inputPath).metadata();
  expect(isHeic(metadata)).toBe(true);
  expect(isHeic({ ...metadata, compression: 'av1' })).toBe(false);
  expect(isHeic({ ...metadata, format: 'jpeg' })).toBe(false);
});

it.each([
  [{ width: null, height: 16, fit: 'cover' as const }, 16, 16],
  [{ width: 8, height: 16, fit: 'cover' as const }, 8, 16],
  [{ width: null, height: 64, fit: 'inside' as const }, 32, 32]
])(
  'decodes HEVC into an explicit JPEG for %j',
  async (target, width, height) => {
    const output = await prepareHeicPreview(inputPath, target);
    expect(await sharp(output).metadata()).toMatchObject({
      format: 'jpeg',
      width,
      height
    });
    expect((await sharp(output).metadata()).exif).toBeUndefined();
    expect(await readFile(inputPath)).toEqual(
      await readFile(join(__dirname, '../../scripts/media-fixtures/heic'))
    );
  }
);

it('returns a typed permanent rejection for a decoder-confirmed invalid input', async () => {
  await writeFile(inputPath, Buffer.from('invalid HEIC container'));
  await expect(
    prepareHeicPreview(inputPath, { width: null, height: 16, fit: 'cover' })
  ).rejects.toMatchObject({ code: 'HEIC_DECODE_FAILED' });
});

it('leaves file I/O failures operational', async () => {
  await rm(inputPath);
  await expect(
    prepareHeicPreview(inputPath, { width: null, height: 16, fit: 'cover' })
  ).rejects.toThrow('HEIC_CONVERSION_WORKER_FAILED');
});

it('does not start a worker without a decode and upload time budget', async () => {
  const child = jest.spyOn(childProcess, 'execFile');
  await expect(
    prepareHeicPreview(
      inputPath,
      { width: null, height: 16, fit: 'cover' },
      2500
    )
  ).rejects.toThrow('HEIC_CONVERSION_DEADLINE_EXCEEDED');
  expect(child).not.toHaveBeenCalled();
});

it.each([
  ['timeout', { killed: true }, '', 'HEIC_CONVERSION_DEADLINE_EXCEEDED'],
  ['worker crash', { code: 1 }, '', 'HEIC_CONVERSION_WORKER_FAILED'],
  [
    'unexpected output',
    null,
    'unknown',
    'HEIC_CONVERSION_INVALID_WORKER_RESPONSE'
  ]
])(
  'keeps %s operational rather than poisoning the rejection cache',
  async (_name, error, stdout, message) => {
    jest
      .spyOn(childProcess, 'execFile')
      .mockImplementationOnce((...args: unknown[]) => {
        const callback = args[3] as (error: unknown, stdout: string) => void;
        callback(error, stdout);
        return {} as childProcess.ChildProcess;
      });
    const result = prepareHeicPreview(inputPath, {
      width: null,
      height: 16,
      fit: 'cover'
    });
    await expect(result).rejects.toThrow(message);
    await expect(result).rejects.not.toBeInstanceOf(UnprocessableResizeInput);
  }
);

it('versions rejection identities with the pinned decoder package', () => {
  const root = require('../../package.json');
  const lambda = require('./package.json');
  expect(root.devDependencies['libheif-js']).toBe('1.23.5');
  expect(lambda.dependencies['libheif-js']).toBe('1.23.5');
  expect(HEIC_DECODER_POLICY).toContain('1.23.5');
});
