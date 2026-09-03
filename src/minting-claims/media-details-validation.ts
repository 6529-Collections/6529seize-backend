import { BadRequestException } from '@/exceptions';
import { MAX_MINTING_CLAIM_MEDIA_BYTES } from '@/minting-claims/media-limits';

export const IMAGE_DETAILS_KEYS = [
  'bytes',
  'format',
  'sha256',
  'width',
  'height'
] as const;
export const VIDEO_ANIMATION_DETAILS_KEYS = [
  'bytes',
  'format',
  'duration',
  'sha256',
  'width',
  'height',
  'codecs'
] as const;
export const HTML_ANIMATION_DETAILS_KEYS = ['format'] as const;
export const GLB_ANIMATION_DETAILS_KEYS = [
  'bytes',
  'format',
  'sha256'
] as const;

export function normalizeSha256(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) return null;
  return normalized;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function appendMissingDetailKeysIssue(
  label: string,
  details: Record<string, unknown> | null,
  requiredKeys: readonly string[],
  invalid: string[]
) {
  if (details == null) {
    return;
  }
  const missingKeys = requiredKeys.filter((key) => !hasOwn(details, key));
  if (missingKeys.length > 0) {
    invalid.push(`${label} (missing keys: ${missingKeys.join(', ')})`);
  }
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function appendBinaryMediaDetailValueIssues(
  label: string,
  details: Record<string, unknown> | null,
  invalid: string[]
) {
  if (details == null) return;
  const issues: string[] = [];
  if (hasOwn(details, 'bytes')) {
    if (!isPositiveInteger(details.bytes)) {
      issues.push('bytes must be positive');
    } else if (details.bytes > MAX_MINTING_CLAIM_MEDIA_BYTES) {
      issues.push('bytes exceeds the Main Stage media limit');
    }
  }
  if (hasOwn(details, 'sha256') && normalizeSha256(details.sha256) == null) {
    issues.push('sha256 must be a 64-character hexadecimal digest');
  }
  if (issues.length > 0) invalid.push(`${label} (${issues.join(', ')})`);
}

function appendImageDetailValueIssues(
  details: Record<string, unknown> | null,
  invalid: string[]
) {
  if (details == null) return;
  appendBinaryMediaDetailValueIssues('MEMES image_details', details, invalid);
  const issues: string[] = [];
  if (hasOwn(details, 'width') && !isPositiveInteger(details.width)) {
    issues.push('width must be positive');
  }
  if (hasOwn(details, 'height') && !isPositiveInteger(details.height)) {
    issues.push('height must be positive');
  }
  if (
    hasOwn(details, 'format') &&
    (typeof details.format !== 'string' || details.format.trim() === '')
  ) {
    issues.push('format must be non-empty');
  }
  if (issues.length > 0) {
    invalid.push(`MEMES image_details (${issues.join(', ')})`);
  }
}

function getRequiredAnimationDetailKeys(
  format: string | null
): readonly string[] {
  if (format === 'HTML') {
    return HTML_ANIMATION_DETAILS_KEYS;
  }
  if (format === 'GLB') {
    return GLB_ANIMATION_DETAILS_KEYS;
  }
  return VIDEO_ANIMATION_DETAILS_KEYS;
}

function appendAnimationFormatIssue(
  details: Record<string, unknown> | null,
  format: string | null,
  invalid: string[]
) {
  if (
    details != null &&
    hasOwn(details, 'format') &&
    (format == null || !['HTML', 'GLB', 'MP4', 'MOV'].includes(format))
  ) {
    invalid.push(
      'MEMES animation_details (format must be HTML, GLB, MP4, or MOV)'
    );
  }
}

function appendVideoAnimationDetailValueIssues(
  details: Record<string, unknown> | null,
  invalid: string[]
) {
  if (details == null) return;
  const issues: string[] = [];
  if (
    hasOwn(details, 'duration') &&
    !isPositiveFiniteNumber(details.duration)
  ) {
    issues.push('duration must be positive');
  }
  if (hasOwn(details, 'width') && !isPositiveInteger(details.width)) {
    issues.push('width must be positive');
  }
  if (hasOwn(details, 'height') && !isPositiveInteger(details.height)) {
    issues.push('height must be positive');
  }
  if (
    hasOwn(details, 'codecs') &&
    (!Array.isArray(details.codecs) ||
      details.codecs.length === 0 ||
      details.codecs.some(
        (codec) => typeof codec !== 'string' || codec.trim() === ''
      ))
  ) {
    issues.push('codecs must contain non-empty strings');
  }
  if (issues.length > 0) {
    invalid.push(`MEMES animation_details (${issues.join(', ')})`);
  }
}

export function getImageDetailIssues(details: unknown): string[] {
  if (!isPlainObject(details))
    return ['MEMES image_details (must be an object)'];
  const invalid: string[] = [];
  appendMissingDetailKeysIssue(
    'MEMES image_details',
    details,
    IMAGE_DETAILS_KEYS,
    invalid
  );
  appendImageDetailValueIssues(details, invalid);
  return invalid;
}

export function getAnimationDetailIssues(details: unknown): string[] {
  if (!isPlainObject(details))
    return ['MEMES animation_details (must be an object)'];
  const invalid: string[] = [];
  const format = typeof details.format === 'string' ? details.format : null;
  appendAnimationFormatIssue(details, format, invalid);
  appendMissingDetailKeysIssue(
    'MEMES animation_details',
    details,
    getRequiredAnimationDetailKeys(format),
    invalid
  );
  if (format !== 'HTML')
    appendBinaryMediaDetailValueIssues(
      'MEMES animation_details',
      details,
      invalid
    );
  if (format !== 'HTML' && format !== 'GLB')
    appendVideoAnimationDetailValueIssues(details, invalid);
  return invalid;
}

export function assertValidComputedMediaDetails(
  issues: readonly string[]
): void {
  if (issues.length > 0) {
    throw new BadRequestException(
      `Invalid computed media details: ${issues.join('; ')}.`
    );
  }
}
