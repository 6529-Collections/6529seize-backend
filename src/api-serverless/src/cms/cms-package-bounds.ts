import { BadRequestException } from '@/exceptions';
import {
  CMS_AGENT_MAX_DEPTH,
  CMS_AGENT_MAX_NODES
} from '@/profile-cms/profile-cms-agent-candidate';

export const LEGACY_CMS_MAX_PACKAGE_JSON_BYTES = 256 * 1024;
export const LEGACY_CMS_MAX_SIGNATURE_JSON_BYTES = 16 * 1024;
export const LEGACY_CMS_MAX_SITES_PER_PROFILE = 20;
export const LEGACY_CMS_MAX_PUBLISHED_PACKAGES_PER_PROFILE = 200;

const UNSUPPORTED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const URL_SCHEME_PREFIX_LENGTH = 32;
const UNSAFE_URL_SCHEME = /^(?:javascript|vbscript|data):/;
// Zero-width and invisible formatting characters that render as nothing and
// can split a scheme name without being visible.
const ZERO_WIDTH_CODE_POINTS = new Set([
  0x00ad, // soft hyphen
  0x180e, // Mongolian vowel separator
  0x200b, // zero width space
  0x200c, // zero width non-joiner
  0x200d, // zero width joiner
  0x200e, // left-to-right mark
  0x200f, // right-to-left mark
  0x2060, // word joiner
  0xfeff // zero width no-break space
]);

function isIgnoredInScheme(code: number): boolean {
  return code <= 0x1f || code === 0x7f || ZERO_WIDTH_CODE_POINTS.has(code);
}

/**
 * Whether a string reads as a javascript:, vbscript: or data: URL. Leading
 * whitespace is ignored, and ASCII control characters and zero-width
 * characters are ignored wherever they appear before the scheme is read.
 */
export function isUnsafeUrlString(value: string): boolean {
  let offset = 0;
  while (
    offset < value.length &&
    (value.charCodeAt(offset) === 0x20 ||
      isIgnoredInScheme(value.charCodeAt(offset)))
  ) {
    offset++;
  }
  let prefix = '';
  for (
    let i = offset;
    i < value.length && prefix.length < URL_SCHEME_PREFIX_LENGTH;
    i++
  ) {
    if (!isIgnoredInScheme(value.charCodeAt(i))) {
      prefix += value[i];
    }
  }
  return UNSAFE_URL_SCHEME.test(prefix.toLowerCase());
}

function serializedJson(input: unknown, fieldName: string): string {
  try {
    return JSON.stringify(input) ?? '';
  } catch {
    throw new BadRequestException(
      `${fieldName} is too deeply nested or large.`
    );
  }
}

/**
 * Bounds a JSON document submitted to the legacy CMS publish route: its
 * nesting depth and node count (checked first), its serialized size, unsupported property names
 * and javascript:/vbscript:/data: URL strings anywhere in it.
 */
export function assertLegacyCmsJsonBounded(
  input: unknown,
  fieldName: string,
  maxBytes: number
): void {
  const stack: Array<{ value: unknown; depth: number }> = [
    { value: input, depth: 0 }
  ];
  let nodes = 0;
  while (stack.length) {
    const { value, depth } = stack.pop()!;
    nodes++;
    if (nodes > CMS_AGENT_MAX_NODES || depth > CMS_AGENT_MAX_DEPTH) {
      throw new BadRequestException(
        `${fieldName} is too deeply nested or large.`
      );
    }
    if (typeof value === 'string') {
      if (isUnsafeUrlString(value)) {
        throw new BadRequestException(
          `${fieldName} must not contain javascript:, vbscript: or data: URLs.`
        );
      }
      continue;
    }
    if (!value || typeof value !== 'object') {
      continue;
    }
    for (const [key, child] of Object.entries(value)) {
      if (UNSUPPORTED_KEYS.has(key)) {
        throw new BadRequestException(
          `${fieldName} contains an unsupported property.`
        );
      }
      stack.push({ value: child, depth: depth + 1 });
    }
  }
  // Serialised only after the depth and node bounds hold, so stringifying
  // cannot recurse without limit.
  const serialized = serializedJson(input, fieldName);
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    throw new BadRequestException(
      `${fieldName} must not exceed ${maxBytes} bytes.`
    );
  }
}
