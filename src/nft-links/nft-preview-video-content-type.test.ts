import { createHash } from 'node:crypto';
import { NftLinkMediaPreviewService } from './nft-link-media-preview.service';
import { NftLinksDb } from './nft-links.db';
import { SQS } from '@/sqs';
import { createPreviewLease } from './nft-preview-size-policy';
import { env } from '@/env';

afterEach(() => jest.restoreAllMocks());

const mp4 = Buffer.concat([
  Buffer.from('000000186674797069736f6d0000000069736f6d6d703432', 'hex'),
  Buffer.alloc(32)
]);
const quicktime = Buffer.concat([
  Buffer.from('0000001466747970717420200000000071742020', 'hex'),
  Buffer.alloc(32)
]);
const webm = Buffer.concat([
  Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84]),
  Buffer.from('webm'),
  Buffer.alloc(32)
]);
const matroska = Buffer.concat([
  Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x88]),
  Buffer.from('matroska'),
  Buffer.alloc(32)
]);
const avi = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.alloc(4),
  Buffer.from('AVI LIST'),
  Buffer.alloc(32)
]);

function fixture(bytes: Buffer, remoteContentType: string | null) {
  const url = 'https://example.com/synthetic-video';
  const sourceHash = createHash('sha256').update(url).digest('hex');
  const lease = createPreviewLease();
  const db = {
    lockMediaPreviewForProcessing: jest.fn().mockResolvedValue({
      canonical_id: 'synthetic',
      media_uri: url,
      full_data: { asset: { media: { kind: 'video', animationUrl: url } } },
      media_preview_source_hash: sourceHash,
      media_preview_error_message: lease
    }),
    updateMediaPreviewWithSuccess: jest.fn().mockResolvedValue(true),
    updateMediaPreviewWithFailure: jest.fn().mockResolvedValue(true)
  };
  const service = new NftLinkMediaPreviewService(
    db as unknown as NftLinksDb,
    {} as SQS
  );
  jest.spyOn(service as never, 'downloadRemoteImage').mockResolvedValue({
    finalUrl: url,
    bytes,
    contentType: remoteContentType
  } as never);
  const s3Send = jest.fn().mockResolvedValue({});
  jest
    .spyOn(service as never, 'getS3Client')
    .mockReturnValue({ send: s3Send } as never);
  jest
    .spyOn(env, 'getStringOrThrow')
    .mockImplementation((key) =>
      key === 'S3_BUCKET' ? 'bucket' : 'https://files.example'
    );
  return {
    service,
    db,
    s3Send,
    message: JSON.stringify({ canonicalId: 'synthetic', sourceHash })
  };
}

it.each([
  ['mp4', mp4, 'text/html', 'video/mp4', 'mp4'],
  ['quicktime', quicktime, 'image/svg+xml', 'video/quicktime', 'mov'],
  ['webm', webm, null, 'video/webm', 'webm']
])(
  'stores %s with the sniffed content type, not the remote header',
  async (_name, bytes, remote, expectedType, extension) => {
    const f = fixture(bytes, remote);
    await f.service.processQueueMessage(f.message, {});
    expect(f.s3Send).toHaveBeenCalledTimes(1);
    const input = f.s3Send.mock.calls[0][0].input;
    expect(input.ContentType).toBe(expectedType);
    expect(input.Key).toMatch(new RegExp(`\\.${extension}$`));
    expect(f.db.updateMediaPreviewWithSuccess).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'video', mimeType: expectedType }),
      {}
    );
  }
);

it.each([
  ['matroska', matroska, 'video/x-matroska'],
  ['avi', avi, 'video/x-msvideo']
])(
  'skips storing a %s container outside the allowlist',
  async (_name, bytes, remote) => {
    const f = fixture(bytes, remote);
    await f.service.processQueueMessage(f.message, {});
    expect(f.s3Send).not.toHaveBeenCalled();
    expect(f.db.updateMediaPreviewWithSuccess).not.toHaveBeenCalled();
    expect(f.db.updateMediaPreviewWithFailure).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'SKIPPED' }),
      {}
    );
  }
);
