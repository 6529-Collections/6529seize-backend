/**
 * Canonical JSON for comparing API answers: keys sorted, selected paths left
 * out, selected arrays compared as sets. Paths are a small JSONPath subset:
 * `$`, `.name`, `[0]` and `[*]`, for example `$.data[*].created_at`.
 */

type Segment = { key: string } | { index: number } | { all: true };
type Place = { parent: any; key: string | number };

const SEGMENT = /\.([A-Za-z0-9_$-]+)|\[(\d+|\*)\]/g;
const ROOT = '$';

export function parsePath(path: string): Segment[] {
  if (!path.startsWith(ROOT)) {
    throw new Error(`Path must start with $: ${path}`);
  }
  const segments: Segment[] = [];
  let consumed = 1;
  for (const match of Array.from(path.slice(1).matchAll(SEGMENT))) {
    if (match.index !== consumed - 1) break;
    consumed += match[0].length;
    if (match[1] !== undefined) segments.push({ key: match[1] });
    else if (match[2] === '*') segments.push({ all: true });
    else segments.push({ index: Number(match[2]) });
  }
  if (consumed !== path.length) throw new Error(`Bad path: ${path}`);
  return segments;
}

function children(value: unknown, segment: Segment): Place[] {
  if (value === null || typeof value !== 'object') return [];
  if ('all' in segment) {
    return Array.isArray(value)
      ? value.map((_, i) => ({ parent: value, key: i }))
      : Object.keys(value).map((key) => ({ parent: value, key }));
  }
  const key = 'key' in segment ? segment.key : segment.index;
  return key in (value as object) ? [{ parent: value, key }] : [];
}

/** The places a path points to, starting from a `{ $: root }` wrapper. */
function locate(
  wrapper: Record<string, unknown>,
  segments: Segment[]
): Place[] {
  let places: Place[] = [{ parent: wrapper, key: ROOT }];
  for (const segment of segments) {
    places = places.flatMap((place) =>
      children(place.parent[place.key], segment)
    );
  }
  return places;
}

/** JSON with every object's keys sorted. */
export function canonicalStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalStringify(item)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    const fields = Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort((a, b) => a.localeCompare(b))
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalStringify(object[key])}`
      );
    return `{${fields.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * The canonical form of an answer: `ignore` paths removed (array items
 * become null, so positions stay), `unordered` arrays sorted by their items'
 * canonical form.
 */
export function canonicalAnswer(
  body: unknown,
  ignore: readonly string[] = [],
  unordered: readonly string[] = []
): string {
  const root: Record<string, unknown> = {
    [ROOT]: body === undefined ? null : JSON.parse(JSON.stringify(body))
  };
  for (const path of ignore) {
    for (const { parent, key } of locate(root, parsePath(path))) {
      if (Array.isArray(parent)) parent[key as number] = null;
      else if (parent === root) parent[key] = null;
      else delete parent[key];
    }
  }
  for (const path of unordered) {
    for (const { parent, key } of locate(root, parsePath(path))) {
      const value = parent[key];
      if (Array.isArray(value)) {
        parent[key] = value
          .map((item) => ({ item, text: canonicalStringify(item) }))
          .sort((a, b) => a.text.localeCompare(b.text))
          .map(({ item }) => item);
      }
    }
  }
  return canonicalStringify(root[ROOT]);
}
