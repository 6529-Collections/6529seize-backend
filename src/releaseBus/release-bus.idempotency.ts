import { createHash } from 'node:crypto';

type OperationKeyParts = {
  readonly trainId: string;
  readonly revision: number;
  readonly operation: string;
  readonly repository?: string;
  readonly environment?: string;
  readonly service?: string;
  readonly expectedSha?: string;
  readonly artifactDigest?: string;
  readonly attempt?: number;
};

function clean(value: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error(`Unsafe idempotency key component: ${value}`);
  }
  return value;
}

export function buildReleaseOperationKey(parts: OperationKeyParts): string {
  if (!Number.isInteger(parts.revision) || parts.revision < 1) {
    throw new Error('revision must be a positive integer');
  }
  const attempt = parts.attempt ?? 1;
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error('attempt must be a positive integer');
  }
  const components = [
    'train',
    clean(parts.trainId),
    'revision',
    String(parts.revision),
    clean(parts.operation)
  ];
  for (const value of [
    parts.repository,
    parts.environment,
    parts.service,
    parts.expectedSha,
    parts.artifactDigest
  ]) {
    if (value) components.push(clean(value));
  }
  components.push('attempt', String(attempt));
  const raw = components.join(':');
  const digest = createHash('sha256').update(raw).digest('hex').slice(0, 32);
  return [
    'rb',
    clean(parts.trainId),
    `r${parts.revision}`,
    clean(parts.operation).slice(0, 48),
    digest,
    `a${attempt}`
  ].join(':');
}
