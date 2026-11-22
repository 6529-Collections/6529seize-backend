/**
 * JSON written the way Python's `json.dumps(value, ensure_ascii=False)` writes
 * it: `", "` between items and `": "` after keys, non-ASCII text as is. The
 * waves snapshot tooling (validator repository, tools/legacy-snapshot) reads
 * the raw drop files a line at a time and finds a drop's id and serial number
 * by their position in that form, so the export writes the same form.
 */
export function pythonJson(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    return pythonNumber(value);
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => pythonJson(item)).join(', ')}]`;
  }
  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, item]) => item !== undefined
    );
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}: ${pythonJson(item)}`)
      .join(', ')}}`;
  }
  throw new Error(`Cannot write a ${typeof value} as JSON`);
}

/**
 * A number as Python writes what it parsed from the API's JSON: a whole
 * number as JavaScript writes it (Python read it as an int, or, past 1e21, as
 * a float it writes the same way), any other as Python's float repr, which
 * switches to an exponent below 1e-4 and from 1e16 (`1e-05`, `1.5e+16`)
 * where JavaScript writes `0.00001`. Both write the shortest digits that read
 * back the same.
 */
export function pythonNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error(`Cannot write ${value} as JSON`);
  }
  if (Number.isInteger(value)) {
    return JSON.stringify(value);
  }
  const [mantissa, exponentText] = Math.abs(value).toExponential().split('e');
  const digits = mantissa.replace('.', '');
  const exponent = Number(exponentText);
  const sign = value < 0 ? '-' : '';
  if (exponent < -4 || exponent >= 16) {
    const fraction = digits.length > 1 ? `.${digits.slice(1)}` : '';
    const magnitude = String(Math.abs(exponent)).padStart(2, '0');
    return `${sign}${digits[0]}${fraction}e${exponent < 0 ? '-' : '+'}${magnitude}`;
  }
  if (exponent < 0) {
    return `${sign}0.${'0'.repeat(-exponent - 1)}${digits}`;
  }
  const whole = digits.slice(0, exponent + 1).padEnd(exponent + 1, '0');
  const fraction = digits.slice(exponent + 1);
  return `${sign}${whole}.${fraction || '0'}`;
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
