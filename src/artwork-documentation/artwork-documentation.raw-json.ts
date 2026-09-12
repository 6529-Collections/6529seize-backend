import { fail } from './artwork-documentation.validation';

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
  if (bytes.length > 524288) fail(413, 'WRITE_REQUEST_LIMIT');
  const source = bytes.toString('utf8');
  const stack: (Set<string> | null)[] = [];
  for (let i = 0; i < source.length; i++) {
    const character = source[i];
    if (character === '{' || character === '[') {
      stack.push(character === '{' ? new Set() : null);
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
