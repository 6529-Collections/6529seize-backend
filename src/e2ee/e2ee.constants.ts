// Limits and fixed values of the E2EE delivery service (D109 contract v1,
// sections 3.3, 4 and 7). Values marked [E] in the contract are engineering
// choices that may change without a protocol version bump.

const KIB = 1024;
const MIB = 1024 * KIB;

export const E2EE_CIPHERSUITE = 1;

export const E2EE_MAX_ACTIVE_DEVICES = 10;
export const E2EE_GRANT_MAX_LIFETIME_SECONDS = 181 * 24 * 60 * 60;
/** A grant may be issued at most this far ahead of the server clock. */
export const E2EE_GRANT_MAX_FUTURE_SKEW_SECONDS = 10 * 60;
export const E2EE_GRANT_ORIGIN_MAX_LENGTH = 64;
export const E2EE_REVOCATION_MAX_SKEW_SECONDS = 10 * 60;
export const E2EE_DEVICE_LABEL_MAX_LENGTH = 48;
export const E2EE_DEFAULT_DEVICE_LABEL = 'Device';
export const E2EE_DEVICE_PLATFORMS = ['web', 'desktop', 'phone'] as const;
/** Revoked (or long expired) devices stay listed for this long. */
export const E2EE_DEVICE_LISTING_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
export const E2EE_LAST_SEEN_UPDATE_INTERVAL_MS = 5 * 60 * 1000;

export const E2EE_MAX_ONE_TIME_KEY_PACKAGES = 100;
export const E2EE_MAX_KEY_PACKAGES_PER_UPLOAD = 100;
export const E2EE_MAX_KEY_PACKAGE_BYTES = 4 * KIB;
/** Last-resort lifetime (90 days) plus a day of clock slack. */
export const E2EE_MAX_KEY_PACKAGE_LIFETIME_SECONDS = 91 * 24 * 60 * 60;

export const E2EE_ENTRY_BUCKETS: readonly number[] = [
  2048, 8192, 32768, 131072, 262144, 524288, 1048576, 2097152
];
export const E2EE_MESSAGE_BUCKETS: readonly number[] = [
  512, 1024, 4096, 16384, 65536
];
export const E2EE_MAX_ENTRY_BYTES = 2 * MIB;
export const E2EE_MAX_MESSAGE_BYTES = 64 * KIB;
/** Welcome plus optional ratchet tree, raw bytes (keeps base64 under 5 MB). */
export const E2EE_MAX_WELCOME_BYTES = 3.5 * MIB;
export const E2EE_MAX_PROPOSALS_PER_EPOCH = 64;
export const E2EE_MAX_ROSTER_DEVICES = 2048;
export const E2EE_MAX_ROSTER_DELTA = 2048;
export const E2EE_MAX_NOTIFY_HINTS = 200;
export const E2EE_MAX_REPORT_BODY_BYTES = 64 * KIB;
export const E2EE_MAX_REPORT_NOTES_LENGTH = 1000;

/** Ciphertext chunk: 1 MiB plaintext plus the 16-byte AES-GCM tag. */
export const E2EE_MAX_BLOB_CHUNK_BYTES = MIB + 16;
export const E2EE_MAX_BLOB_CHUNKS = 25;
export const E2EE_MAX_BLOB_BYTES =
  E2EE_MAX_BLOB_CHUNKS * E2EE_MAX_BLOB_CHUNK_BYTES;

/**
 * Blob storage quota per uploading profile, in declared ciphertext bytes.
 * v1 stores attachment chunks in MySQL; see docs/e2ee-messaging.md.
 */
export const E2EE_BLOB_QUOTA = {
  rollingWindowMs: 24 * 60 * 60 * 1000,
  rollingBytes: 200 * MIB,
  liveBytes: 1024 * MIB
} as const;

export const E2EE_MAX_CLAIM_TARGETS = 100;
export const E2EE_MAX_ELIGIBILITY_PROFILES = 100;
export const E2EE_LOG_DEFAULT_LIMIT = 100;
export const E2EE_LOG_MAX_LIMIT = 200;
/** Raw ciphertext bytes per log or welcome page (Lambda responses <= 6 MB). */
export const E2EE_PAGE_BYTE_BUDGET = 2.5 * MIB;
export const E2EE_MAX_WELCOMES_PER_PAGE = 50;
export const E2EE_MAX_DEVICE_GROUPS = 2000;
/** Largest log item sent inline in a WebSocket event (frames stay < 28 KiB). */
export const E2EE_WS_INLINE_ITEM_MAX_BYTES = 16 * KIB;
export const E2EE_PUSH_THROTTLE_MS = 60 * 1000;

export const E2EE_RETENTION = {
  messagesMs: 90 * 24 * 60 * 60 * 1000,
  entriesMs: 180 * 24 * 60 * 60 * 1000,
  welcomeDeliveriesMs: 30 * 24 * 60 * 60 * 1000,
  blobsMs: 365 * 24 * 60 * 60 * 1000,
  incompleteBlobsMs: 24 * 60 * 60 * 1000,
  revokedDevicesMs: 365 * 24 * 60 * 60 * 1000,
  rateCountersMs: 2 * 24 * 60 * 60 * 1000,
  pushThrottleMs: 24 * 60 * 60 * 1000,
  batchSize: 100,
  /** Blobs per prune pass (each up to 25 chunks of 1 MiB). */
  blobBatchSize: 5,
  /** Probability that a successful write also prunes. */
  probability: 0.01
} as const;

export interface E2eeRateLimit {
  readonly scope: string;
  readonly limit: number;
  readonly windowMs: number;
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const E2EE_RATE_LIMITS = {
  messagesPerDevice: { scope: 'msg', limit: 120, windowMs: MINUTE },
  entriesPerGroup: { scope: 'entry', limit: 30, windowMs: HOUR },
  rosterRepairsPerGroup: { scope: 'roster', limit: 60, windowMs: HOUR },
  claimsPerProfile: { scope: 'claim', limit: 120, windowMs: HOUR },
  claimsPerTargetDevice: { scope: 'claimed', limit: 30, windowMs: HOUR },
  groupCreationsPerProfile: { scope: 'group', limit: 200, windowMs: DAY },
  blobUploadsPerProfile: { scope: 'blob', limit: 100, windowMs: DAY },
  eligibilityPerProfile: { scope: 'elig', limit: 600, windowMs: HOUR },
  reportsPerProfile: { scope: 'report', limit: 100, windowMs: DAY },
  /** Log and welcome ciphertext bytes per profile per UTC day. */
  logBytesPerProfile: { scope: 'bytes', limit: 256 * MIB, windowMs: DAY }
} satisfies Record<string, E2eeRateLimit>;

export const E2EE_ERROR_CODES = {
  DISABLED: 'E2EE_DISABLED',
  NOT_YOUR_DEVICE: 'E2EE_NOT_YOUR_DEVICE',
  DEVICE_LIMIT: 'E2EE_DEVICE_LIMIT',
  DEVICE_EXISTS: 'E2EE_DEVICE_EXISTS',
  KEY_PACKAGE_LIMIT: 'E2EE_KEY_PACKAGE_LIMIT',
  BAD_GRANT: 'E2EE_BAD_GRANT',
  BAD_SIGNATURE: 'E2EE_BAD_SIGNATURE',
  BAD_REQUEST: 'E2EE_BAD_REQUEST',
  EPOCH_CONFLICT: 'E2EE_EPOCH_CONFLICT',
  EPOCH_STALE: 'E2EE_EPOCH_STALE',
  NOT_MEMBER: 'E2EE_NOT_MEMBER',
  POLICY: 'E2EE_POLICY',
  BLOCKED: 'E2EE_BLOCKED',
  TOO_LARGE: 'E2EE_TOO_LARGE',
  RATE_LIMITED: 'E2EE_RATE_LIMITED',
  NOT_FOUND: 'E2EE_NOT_FOUND',
  FORBIDDEN: 'E2EE_FORBIDDEN'
} as const;
