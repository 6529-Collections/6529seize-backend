import { fail } from './artwork-documentation.validation';

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
    while (++i < source.length) {
      if (source[i] === '\\') i++;
      else if (source[i] === '"') break;
    }
    let next = i + 1;
    while (/\s/.test(source[next] ?? '') && next < source.length) next++;
    if (source[next] !== ':') continue;
    let key: string;
    try {
      key = JSON.parse(source.slice(start, i + 1));
    } catch {
      fail(422, 'INVALID_JSON');
    }
    const keys = stack[stack.length - 1];
    if (!keys || keys.has(key)) fail(422, 'DUPLICATE_JSON_KEY');
    if (['__proto__', 'prototype', 'constructor'].includes(key))
      fail(422, 'INVALID_FIELD');
    keys.add(key);
  }
}
