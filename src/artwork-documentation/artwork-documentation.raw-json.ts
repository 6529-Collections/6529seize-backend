import { fail } from './artwork-documentation.validation';

export const DOCUMENTATION_RAW_WRITE_BYTES = 5000000;

function stringEnd(source: string, start: number): number {
  let end = start;
  while (++end < source.length) {
    if (source[end] === '\\') end++;
    else if (source[end] === '"') break;
  }
  return end;
}
function registerKey(
  source: string,
  start: number,
  end: number,
  keys: Set<string> | null | undefined
): void {
  let next = end + 1;
  while (next < source.length && /\s/.test(source[next])) next++;
  if (source[next] !== ':') return;
  let key: string;
  try {
    key = JSON.parse(source.slice(start, end + 1));
  } catch {
    fail(422, 'INVALID_JSON');
  }
  if (!keys || keys.has(key)) fail(422, 'DUPLICATE_JSON_KEY');
  if (['__proto__', 'prototype', 'constructor'].includes(key))
    fail(422, 'INVALID_FIELD');
  keys.add(key);
}

/** Runs before JSON.parse discards duplicate keys. Does not retain request bytes. */
export function validateDocumentationRawJson(bytes: Buffer): void {
  if (bytes.length > DOCUMENTATION_RAW_WRITE_BYTES)
    fail(413, 'WRITE_REQUEST_LIMIT');
  const source = bytes.toString('utf8');
  const stack: (Set<string> | null)[] = [];
  for (let i = 0; i < source.length; i++) {
    const character = source[i];
    if (character === '{' || character === '[') {
      stack.push(character === '{' ? new Set() : null);
      // Match normalizeJson's maximum container depth before JSON.parse allocates it.
      if (stack.length > 31) fail(422, 'INVALID_VALUE');
      continue;
    }
    if (character === '}' || character === ']') {
      stack.pop();
      continue;
    }
    if (character !== '"') continue;
    const start = i;
    i = stringEnd(source, start);
    registerKey(source, start, i, stack[stack.length - 1]);
  }
}
