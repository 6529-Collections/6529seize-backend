import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { DropMediaSanitizerService } from '@/drops/drop-media-sanitizer.service';
import {
  prepareChatVideoFile,
  VIDEO_METADATA_NOT_REMOVED_MESSAGE,
  VIDEO_TOO_LARGE_MESSAGE
} from '@/drops/drop-media-video-sanitizer';
import {
  DropMediaUploadPurpose,
  DropMediaUploadStatus
} from '@/entities/IDropMediaUpload';
import { Logger } from '@/logging';
import {
  androidVideo,
  box,
  goProVideo,
  IDENTIFYING_STRINGS,
  iphoneVideo
} from '@/media/video-metadata-strip/fixtures/synthetic-video-fixtures';
import * as verification from '@/media/video-metadata-strip/video-strip-verification';
import { verifyVideoStrip } from '@/media/video-metadata-strip/video-strip-verification';

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'drop-video-sanitizer-'));
});

afterEach(async () => {
  jest.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

async function fileOf(bytes: Buffer, name: string): Promise<string> {
  const path = join(directory, name);
  await writeFile(path, bytes);
  return path;
}

function expectNoIdentifyingStrings(bytes: Buffer): void {
  for (const value of IDENTIFYING_STRINGS) {
    expect(bytes.includes(Buffer.from(value, 'latin1'))).toBe(false);
  }
}

describe('prepareChatVideoFile', () => {
  it('publishes a verified stripped copy', async () => {
    const source = await fileOf(goProVideo(), 'source');
    const prepared = await prepareChatVideoFile(source);
    expect(prepared).toMatchObject({
      kind: 'publish',
      path: join(directory, 'stripped-video'),
      summary: expect.stringContaining('dropped tracks [meta, tmcd]')
    });
  });

  it('publishes the original when nothing identifying is in it', async () => {
    const first = await prepareChatVideoFile(
      await fileOf(androidVideo(), 'source')
    );
    expect(first.kind).toBe('publish');
    if (first.kind !== 'publish') return;
    const cleanDirectory = await mkdtemp(join(directory, 'clean-'));
    const clean = join(cleanDirectory, 'source');
    await writeFile(clean, await readFile(first.path));
    expect(await prepareChatVideoFile(clean)).toMatchObject({
      kind: 'publish',
      path: clean
    });
  });

  it('rejects an unsupported structure', async () => {
    const fragmented = Buffer.concat([
      androidVideo(),
      box('moof', box('mfhd', Buffer.alloc(8)))
    ]);
    expect(
      await prepareChatVideoFile(await fileOf(fragmented, 'source'))
    ).toMatchObject({ kind: 'reject', verificationFailed: false });
  });

  it('rejects a strip that does not verify', async () => {
    jest
      .spyOn(verification, 'verifyVideoStrip')
      .mockResolvedValue({ ok: false, reason: 'synthetic failure' });
    expect(
      await prepareChatVideoFile(await fileOf(iphoneVideo(), 'source'))
    ).toEqual({
      kind: 'reject',
      reason: 'stripped video did not verify (synthetic failure)',
      verificationFailed: true
    });
  });
});

describe('chat video sanitization before publication', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.S3_BUCKET = 'public-bucket';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  function pipeline(
    input: Buffer,
    {
      declaredMimeType = 'video/quicktime',
      purpose = DropMediaUploadPurpose.CHAT,
      contentLength = input.length
    }: {
      declaredMimeType?: string;
      purpose?: DropMediaUploadPurpose;
      contentLength?: number;
    } = {}
  ) {
    const upload = {
      id: 'upload',
      status: DropMediaUploadStatus.PROCESSING,
      ingest_bucket: 'ingest-bucket',
      ingest_key: 'prod/drop-media-ingest/drops/upload/upload.mov',
      public_key: 'drops/upload/upload.mov',
      declared_mime_type: declaredMimeType,
      purpose
    };
    let status = upload.status;
    let errorReason: string | null = null;
    const uploadsDb = {
      findById: jest.fn(async () => ({ ...upload, status })),
      transitionStatus: jest.fn(
        async ({
          toStatus,
          patch
        }: {
          toStatus: DropMediaUploadStatus;
          patch?: { error_reason?: string | null };
        }) => {
          status = toStatus;
          errorReason = patch?.error_reason ?? errorReason;
          return true;
        }
      )
    };
    const ingestSend = jest.fn(async (command: unknown) => {
      if (command instanceof DeleteObjectCommand) return {};
      return {
        Body: Readable.from([input]),
        ContentLength: contentLength,
        Metadata: { 'sanitize-image-metadata': 'true' }
      };
    });
    const published: { key: string; body: Buffer; input: any }[] = [];
    const publicSend = jest.fn(async (command: unknown) => {
      if (command instanceof PutObjectCommand) {
        const chunks: Buffer[] = [];
        for await (const chunk of command.input.Body as Readable) {
          chunks.push(Buffer.from(chunk));
        }
        published.push({
          key: command.input.Key!,
          body: Buffer.concat(chunks),
          input: command.input
        });
      }
      return {};
    });
    const notifier = { notifyStatusTransition: jest.fn() };
    const service = new DropMediaSanitizerService(
      uploadsDb as any,
      () => ({ send: publicSend }) as any,
      () => ({ send: ingestSend }) as any,
      notifier as any
    );
    return {
      process: () =>
        service.processUpload({
          mediaUploadId: 'upload',
          approximateReceiveCount: 1
        }),
      published,
      ingestSend,
      notifier,
      status: () => status,
      errorReason: () => errorReason
    };
  }

  it('publishes an iPhone video without its location, keeping every sample', async () => {
    const input = iphoneVideo();
    const info = jest.spyOn(Logger.prototype, 'info').mockImplementation();
    const p = pipeline(input);

    await p.process();

    expect(p.status()).toBe(DropMediaUploadStatus.READY);
    expect(p.published).toHaveLength(1);
    const [video] = p.published;
    expect(video.key).toBe('drops/upload/upload.mov');
    expect(video.input).toMatchObject({
      Bucket: 'public-bucket',
      ContentType: 'video/quicktime',
      CacheControl: 'public, max-age=31536000, immutable',
      Metadata: { 'privacy-sanitized': 'true' }
    });
    expectNoIdentifyingStrings(video.body);
    const verified = await verifyVideoStrip(
      await fileOf(input, 'original'),
      await fileOf(video.body, 'published')
    );
    expect(verified.ok).toBe(true);
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining(
        'Video metadata strip for drop media upload upload: removed location'
      )
    );
    expect(p.ingestSend).toHaveBeenLastCalledWith(
      expect.any(DeleteObjectCommand)
    );
    expect(p.notifier.notifyStatusTransition).toHaveBeenCalledWith('upload');
  });

  it('fails a video it cannot strip instead of publishing its metadata', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const fragmented = Buffer.concat([
      goProVideo(),
      box('moof', box('mfhd', Buffer.alloc(8)))
    ]);
    const p = pipeline(fragmented, { declaredMimeType: 'video/mp4' });

    await p.process();

    expect(p.published).toHaveLength(0);
    expect(p.status()).toBe(DropMediaUploadStatus.FAILED);
    expect(p.errorReason()).toBe(VIDEO_METADATA_NOT_REMOVED_MESSAGE);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('unsupported video structure (fragmented')
    );
  });

  it('fails a video whose strip does not verify', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    jest
      .spyOn(verification, 'verifyVideoStrip')
      .mockResolvedValue({ ok: false, reason: 'synthetic failure' });
    const p = pipeline(androidVideo(), { declaredMimeType: 'video/mp4' });

    await p.process();

    expect(p.published).toHaveLength(0);
    expect(p.errorReason()).toBe(VIDEO_METADATA_NOT_REMOVED_MESSAGE);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('did not verify (synthetic failure)')
    );
  });

  it('keeps a decision entry video byte for byte', async () => {
    const input = iphoneVideo();
    const p = pipeline(input, {
      purpose: DropMediaUploadPurpose.DECISION_ENTRY
    });

    await p.process();

    expect(p.status()).toBe(DropMediaUploadStatus.READY);
    expect(p.published[0].body.equals(input)).toBe(true);
    expect(p.published[0].input.Metadata).toBeUndefined();
  });

  it('refuses videos over the transport limit before downloading them', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const p = pipeline(Buffer.alloc(0), {
      declaredMimeType: 'video/mp4',
      contentLength: 500 * 1024 * 1024 + 1
    });

    await p.process();

    expect(p.published).toHaveLength(0);
    expect(p.errorReason()).toBe(VIDEO_TOO_LARGE_MESSAGE);
  });
});
