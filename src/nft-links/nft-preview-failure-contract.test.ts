import { createHash } from 'node:crypto';
import { NftLinkMediaPreviewService } from './nft-link-media-preview.service';
import { NftLinksDb } from './nft-links.db';
import { SQS } from '@/sqs';
import {
  createPreviewLease,
  NftPreviewOversizeError
} from './nft-preview-size-policy';

afterEach(() => jest.restoreAllMocks());

function fixture(error: Error) {
  const url = 'https://example.com/synthetic.png';
  const sourceHash = createHash('sha256').update(url).digest('hex');
  const lease = createPreviewLease();
  const write = jest.fn().mockResolvedValue(true);
  const db = {
    lockMediaPreviewForProcessing: jest.fn().mockResolvedValue({
      canonical_id: 'synthetic',
      media_uri: url,
      media_preview_source_hash: sourceHash,
      media_preview_error_message: lease
    }),
    updateMediaPreviewWithFailure: write
  };
  const service = new NftLinkMediaPreviewService(
    db as unknown as NftLinksDb,
    {} as SQS
  );
  jest
    .spyOn(service as never, 'downloadRemoteImage')
    .mockRejectedValue(error as never);
  const logged = jest
    .spyOn(service['logger'], 'error')
    .mockImplementation(() => undefined);
  return {
    service,
    write,
    logged,
    sourceHash,
    lease,
    message: JSON.stringify({ canonicalId: 'synthetic', sourceHash })
  };
}

it.each(['content-length', 'stream'] as const)(
  'persists and reports the first typed %s failure with the acquired fence',
  async (mode) => {
    const error = new NftPreviewOversizeError(200, 271, mode);
    const f = fixture(error);
    await expect(
      f.service.processQueueMessage(f.message, {})
    ).resolves.toBeUndefined();
    expect(f.write).toHaveBeenCalledWith(
      {
        canonicalId: 'synthetic',
        message: error.toStoredMessage(),
        fence: { sourceHash: f.sourceHash, lease: f.lease }
      },
      {}
    );
    expect(f.logged).toHaveBeenCalledTimes(1);
    expect(f.logged.mock.calls[0][1]).toBe(error);
  }
);

it.each([
  'HTTP 429',
  'HTTP 503',
  'Input buffer contains unsupported image format'
])('keeps generic failure behavior for %s', async (message) => {
  const f = fixture(new Error(message));
  await f.service.processQueueMessage(f.message, {});
  expect(f.write.mock.calls[0][0].message).toBe(message);
  expect(f.logged).toHaveBeenCalledTimes(1);
});

it('rejects the invocation if failure persistence fails', async () => {
  const f = fixture(new NftPreviewOversizeError(200, 271, 'stream'));
  f.write.mockRejectedValue(new Error('synthetic persistence failure'));
  await expect(f.service.processQueueMessage(f.message, {})).rejects.toThrow(
    'synthetic persistence failure'
  );
});
