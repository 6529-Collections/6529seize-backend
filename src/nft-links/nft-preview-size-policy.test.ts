import {
  createPreviewLease,
  isPreviewLease,
  isPreviewSizeCooldownActive,
  NFT_PREVIEW_SIZE_COOLDOWN_MS,
  NftPreviewOversizeError
} from './nft-preview-size-policy';

const now = 1_800_000_000_000;
const base = {
  status: 'FAILED',
  sourceHash: 'source-a',
  expectedSourceHash: 'source-a',
  message: new NftPreviewOversizeError(
    200,
    271,
    'content-length'
  ).toStoredMessage(),
  lastTriedAt: now - 1,
  limitBytes: 200,
  now
};

it('keeps the first typed failure eligible again exactly one hour later', () => {
  expect(isPreviewSizeCooldownActive(base)).toBe(true);
  expect(
    isPreviewSizeCooldownActive({
      ...base,
      lastTriedAt: now - NFT_PREVIEW_SIZE_COOLDOWN_MS
    })
  ).toBe(false);
  expect(
    isPreviewSizeCooldownActive({
      ...base,
      lastTriedAt: now - NFT_PREVIEW_SIZE_COOLDOWN_MS + 1
    })
  ).toBe(true);
});

it.each([
  { status: 'READY' },
  { status: 'PENDING' },
  { status: 'PROCESSING' },
  { status: 'SKIPPED' },
  { sourceHash: 'source-b' },
  { sourceHash: null },
  { limitBytes: 300 },
  { limitBytes: 100 },
  { message: 'Remote media too large (271 bytes > 200)' },
  { message: null },
  { message: '{}' },
  { message: '{bad' },
  { message: 'x'.repeat(513) },
  { message: base.message.replace('/v1', '/v2') },
  { message: base.message.replace('271', '199') },
  { message: base.message.replace('content-length', 'unknown') },
  { message: base.message.replace('200', '0') },
  { message: JSON.stringify({ ...JSON.parse(base.message), extra: true }) },
  { lastTriedAt: null },
  { lastTriedAt: 0 },
  { lastTriedAt: -1 },
  { lastTriedAt: 'broken' },
  { lastTriedAt: Number.MAX_SAFE_INTEGER },
  { lastTriedAt: now + 1 }
])('does not strand work when state/config changes: %j', (change) => {
  expect(isPreviewSizeCooldownActive({ ...base, ...change })).toBe(false);
});

it('supports stream overruns and numeric DB bigint strings without exposing URLs', () => {
  const error = new NftPreviewOversizeError(200, 201, 'stream');
  expect(error.toStoredMessage().length).toBeLessThan(160);
  expect(
    isPreviewSizeCooldownActive({
      ...base,
      message: error.toStoredMessage(),
      lastTriedAt: String(now)
    })
  ).toBe(true);
});

it('uses distinct bounded opaque leases even within the same clock tick', () => {
  const a = createPreviewLease();
  const b = createPreviewLease();
  expect(a).not.toBe(b);
  expect(a.length).toBe(57);
  expect(isPreviewLease(a)).toBe(true);
  expect(isPreviewLease(b)).toBe(true);
  for (const bad of ['', 'old error', a.replace('/v1', '/v2'), a + 'x'])
    expect(isPreviewLease(bad)).toBe(false);
});

const videoFailure = new NftPreviewOversizeError(250, 260, 'stream', {
  imageBytes: 200,
  videoBytes: 250
}).toStoredMessage();
it('shares video-aware cooldown policy and retries when either limit changes', () => {
  const state = { ...base, message: videoFailure, videoLimitBytes: 250 };
  expect(isPreviewSizeCooldownActive(state)).toBe(true);
  expect(isPreviewSizeCooldownActive({ ...state, videoLimitBytes: 300 })).toBe(
    false
  );
  expect(isPreviewSizeCooldownActive({ ...state, limitBytes: 150 })).toBe(
    false
  );
  expect(isPreviewSizeCooldownActive({ ...state, message: base.message })).toBe(
    false
  );
});
it('retains cooldown for an image rejected under the current video-aware policy', () => {
  const message = new NftPreviewOversizeError(200, 220, 'stream', {
    imageBytes: 200,
    videoBytes: 250
  }).toStoredMessage();
  expect(
    isPreviewSizeCooldownActive({ ...base, message, videoLimitBytes: 250 })
  ).toBe(true);
});
