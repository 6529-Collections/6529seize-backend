/**
 * The raw files are written the way the waves snapshot tooling's fetch stage
 * writes them (validator repository, tools/legacy-snapshot):
 *
 * - It parses the API's JSON with `parse_float=str`, so a number the API
 *   writes with a fraction or an exponent (`0.5`, `1e-7`, `1e+21`) is kept as
 *   that text, a JSON string; other numbers stay numbers. `fetchForm` gives
 *   a value that form.
 * - It writes drop lines with Python's `json.dumps(value,
 *   ensure_ascii=False)`: `", "` between items, `": "` after keys, non-ASCII
 *   text as is. Its normalize stage finds a drop's id and serial number by
 *   their position in that form. `pythonJson` writes it.
 */

/** The API's JSON text for a number. */
function numberText(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error(`Cannot write ${value} as JSON`);
  }
  return JSON.stringify(value);
}

/** True for JSON number text Python reads as a float (a fraction or exponent). */
function isFloatText(text: string): boolean {
  return /[.eE]/.test(text);
}

/**
 * The value as the fetch stage holds it after parsing the API's JSON: a
 * number with a fraction or an exponent becomes its JSON text, a string;
 * dates become ISO text; undefined fields are left out.
 */
export function fetchForm(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'number') {
    const text = numberText(value);
    return isFloatText(text) ? text : value;
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map((item) => (item === undefined ? null : fetchForm(item)));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(
      value as Record<string, unknown>
    )) {
      if (item !== undefined) {
        out[key] = fetchForm(item);
      }
    }
    return out;
  }
  throw new Error(`Cannot write a ${typeof value} as JSON`);
}

/** Python's json.dumps(fetchForm(value), ensure_ascii=False). */
export function pythonJson(value: unknown): string {
  return pythonDumps(fetchForm(value));
}

function pythonDumps(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    return numberText(value);
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => pythonDumps(item)).join(', ')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}: ${pythonDumps(item)}`)
    .join(', ')}}`;
}

/**
 * Orders strings by Unicode code point, as Python's `sorted` does (plain
 * JavaScript comparison orders UTF-16 code units, which differs for text
 * outside the Basic Multilingual Plane).
 */
export function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left);
  const b = Array.from(right);
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const diff = a[i].codePointAt(0)! - b[i].codePointAt(0)!;
    if (diff !== 0) {
      return diff;
    }
  }
  return a.length - b.length;
}
