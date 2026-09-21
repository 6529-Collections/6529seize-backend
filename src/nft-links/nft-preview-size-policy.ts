import { randomUUID } from 'node:crypto';

export const NFT_PREVIEW_SIZE_COOLDOWN_MS = 60 * 60 * 1000;
const OVERSIZE_TYPE = 'nft-preview-oversize/v1';

export function createPreviewLease(): string {
  return `nft-preview-lease/v1:${randomUUID()}`;
}

export function isPreviewLease(value: string): boolean {
  return /^nft-preview-lease\/v1:[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(
    value
  );
}

export interface PreviewCompletionFence {
  readonly sourceHash: string | null;
  readonly lease: string;
}

type OversizeMode = 'content-length' | 'stream';

export class NftPreviewOversizeError extends Error {
  constructor(
    readonly limitBytes: number,
    readonly observedBytes: number,
    readonly mode: OversizeMode,
    readonly policy?: { imageBytes: number; videoBytes: number }
  ) {
    super(`NFT preview exceeds byte limit (${observedBytes} > ${limitBytes})`);
    Object.setPrototypeOf(this, NftPreviewOversizeError.prototype);
    this.name = 'NftPreviewOversizeError';
  }

  toStoredMessage(): string {
    return JSON.stringify({
      type: OVERSIZE_TYPE,
      limitBytes: this.limitBytes,
      observedBytes: this.observedBytes,
      mode: this.mode,
      ...(this.policy ? { policy: this.policy } : {})
    });
  }
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function matchesSizePolicy(
  state: Record<string, unknown>,
  imageBytes: number,
  videoBytes?: number
): boolean {
  if (videoBytes === undefined) return state.limitBytes === imageBytes;
  const policy = state.policy as
    | { imageBytes?: unknown; videoBytes?: unknown }
    | undefined;
  return (
    !!policy &&
    Object.keys(policy).length === 2 &&
    policy.imageBytes === imageBytes &&
    policy.videoBytes === videoBytes &&
    (state.limitBytes === imageBytes || state.limitBytes === videoBytes)
  );
}

export function isCurrentPreviewOversizeMessage(
  message: string | null,
  limitBytes: number,
  videoLimitBytes?: number
): boolean {
  if (!message || message.length > 512) return false;
  try {
    const value: unknown = JSON.parse(message);
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return false;
    const state = value as Record<string, unknown>;
    return (
      Object.keys(state).length === (videoLimitBytes === undefined ? 4 : 5) &&
      state.type === OVERSIZE_TYPE &&
      isPositiveInteger(state.limitBytes) &&
      matchesSizePolicy(state, limitBytes, videoLimitBytes) &&
      isPositiveInteger(state.observedBytes) &&
      state.observedBytes > state.limitBytes &&
      (state.mode === 'content-length' || state.mode === 'stream')
    );
  } catch {
    return false;
  }
}

export function isPreviewSizeCooldownActive({
  status,
  sourceHash,
  expectedSourceHash,
  message,
  lastTriedAt,
  limitBytes,
  videoLimitBytes,
  now
}: {
  status: string | null;
  sourceHash: string | null;
  expectedSourceHash: string;
  message: string | null;
  lastTriedAt: number | string | null;
  limitBytes: number;
  videoLimitBytes?: number;
  now: number;
}): boolean {
  const lastAttempt = Number(lastTriedAt);
  return (
    status === 'FAILED' &&
    sourceHash === expectedSourceHash &&
    isCurrentPreviewOversizeMessage(message, limitBytes, videoLimitBytes) &&
    isPositiveInteger(lastAttempt) &&
    lastAttempt <= now &&
    now - lastAttempt < NFT_PREVIEW_SIZE_COOLDOWN_MS
  );
}
