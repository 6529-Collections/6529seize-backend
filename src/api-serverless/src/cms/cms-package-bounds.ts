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

/**
 * Whether a string reads as a javascript:, vbscript: or data: URL the way a
 * browser parses it: leading whitespace and control characters, and tabs or
 * line breaks inside the scheme, are ignored.
 */
export function isUnsafeUrlString(value: string): boolean {
  let offset = 0;
  while (offset < value.length && value.charCodeAt(offset) <= 0x20) {
    offset++;
  }
  const start = value
    .slice(offset, offset + URL_SCHEME_PREFIX_LENGTH)
    .replace(/[\t\n\r]/g, '')
    .toLowerCase();
  return UNSAFE_URL_SCHEME.test(start);
}

/**
 * Bounds a JSON document submitted to the legacy CMS publish route: its
 * serialized size, nesting depth and node count, unsupported property names
 * and javascript:/vbscript:/data: URL strings anywhere in it.
 */
export function assertLegacyCmsJsonBounded(
  input: unknown,
  fieldName: string,
  maxBytes: number
): void {
  const serialized = JSON.stringify(input) ?? '';
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    throw new BadRequestException(
      `${fieldName} must not exceed ${maxBytes} bytes.`
    );
  }
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
}
