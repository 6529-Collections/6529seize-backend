/**
 * Profile documents (P37 4.2): what a chain identity's profile says, kept off
 * the chain and named by CID. The chain holds only the CID; the gateway's
 * document store serves the bytes.
 *
 * ProfileDoc.v1 in canonical encoding (CE, P28 2.6), as the import writes it:
 *   string schema ("6529.ProfileDoc.v1") || bytes32 principal || uint32 version
 *   || bytes prev (<= 64) || bytes32 nonce
 *   || list<(string key, string value)> fields (keys ascending) || bytes sig
 * where string and bytes are `uint32 length || bytes` and a list is
 * `uint32 count || items`, all big-endian. A JSON object (`{"fields": {...}}`
 * or the fields themselves) is read too, for documents uploaded as JSON.
 */
export const PROFILE_DOC_SCHEMA = '6529.ProfileDoc.v1';

const MAX_FIELDS = 256;
const MAX_KEY = 64;
const MAX_VALUE = 8192;

export interface ProfileDocStatement {
  readonly group: string;
  readonly type: string;
  readonly value: string;
  readonly comment: string | null;
}

/** The 6529.io columns a profile document fills. */
export interface ProfileDocFields {
  readonly pfp: string | null;
  readonly banner1: string | null;
  readonly banner2: string | null;
  readonly website: string | null;
  readonly classification: string | null;
  readonly subClassification: string | null;
  readonly statements: ProfileDocStatement[];
}

export class ProfileDocError extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'ProfileDocError';
  }
}

class Reader {
  private offset = 0;
  constructor(private readonly bytes: Buffer) {}

  private take(n: number): Buffer {
    if (n < 0 || this.offset + n > this.bytes.length) {
      throw new ProfileDocError('Truncated profile document');
    }
    const out = this.bytes.subarray(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }

  uint32(): number {
    return this.take(4).readUInt32BE(0);
  }

  fixed(n: number): Buffer {
    return this.take(n);
  }

  bytesField(max: number): Buffer {
    const length = this.uint32();
    if (length > max) {
      throw new ProfileDocError(`A field of ${length} bytes is over ${max}`);
    }
    return this.take(length);
  }

  string(max: number): string {
    const raw = this.bytesField(max);
    const text = raw.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(raw)) {
      throw new ProfileDocError('A string is not UTF-8');
    }
    return text;
  }

  done(): boolean {
    return this.offset === this.bytes.length;
  }
}

/** The fields of a CE ProfileDoc.v1, keys strictly ascending. */
export function decodeCeProfileDoc(bytes: Buffer): Record<string, string> {
  const reader = new Reader(bytes);
  const schema = reader.string(64);
  if (schema !== PROFILE_DOC_SCHEMA) {
    throw new ProfileDocError(`Unknown profile document schema "${schema}"`);
  }
  reader.fixed(32); // principal
  reader.uint32(); // version
  reader.bytesField(64); // prev
  reader.fixed(32); // nonce
  const count = reader.uint32();
  if (count > MAX_FIELDS) {
    throw new ProfileDocError(`${count} fields is over ${MAX_FIELDS}`);
  }
  const fields: Record<string, string> = {};
  let previous: Buffer | null = null;
  for (let i = 0; i < count; i++) {
    const keyBytes = Buffer.from(reader.string(MAX_KEY), 'utf8');
    if (previous && Buffer.compare(previous, keyBytes) >= 0) {
      throw new ProfileDocError('Profile document keys are not ascending');
    }
    previous = keyBytes;
    fields[keyBytes.toString('utf8')] = reader.string(MAX_VALUE);
  }
  reader.bytesField(1024); // sig
  if (!reader.done()) {
    throw new ProfileDocError('Trailing bytes after the profile document');
  }
  return fields;
}

function decodeJsonProfileDoc(bytes: Buffer): Record<string, string> | null {
  let doc: unknown;
  try {
    doc = JSON.parse(bytes.toString('utf8'));
  } catch {
    return null;
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return null;
  }
  const source = (doc as { fields?: unknown }).fields ?? doc;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return null;
  }
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string') fields[key] = value;
  }
  return fields;
}

/** A document's fields, from CE (the import's form) or JSON. */
export function decodeProfileDoc(bytes: Buffer): Record<string, string> {
  try {
    return decodeCeProfileDoc(bytes);
  } catch (error) {
    const json = decodeJsonProfileDoc(bytes);
    if (json) return json;
    throw error;
  }
}

const STATEMENT_KEY = /^statement\.([^.]+)\.([^.]+)\.(\d+)$/;

function nonEmpty(value: string | undefined): string | null {
  return value !== undefined && value.length > 0 ? value : null;
}

/**
 * The 6529.io columns from a document's fields. Statements are
 * `statement.<group>.<type>.<n>` with an optional `....<n>.comment`,
 * in n order within a group and type.
 */
export function toProfileDocFields(
  fields: Record<string, string>
): ProfileDocFields {
  const statements: (ProfileDocStatement & { order: number })[] = [];
  for (const [key, value] of Object.entries(fields)) {
    const match = STATEMENT_KEY.exec(key);
    if (!match || !value) continue;
    statements.push({
      group: match[1],
      type: match[2],
      value,
      comment: nonEmpty(fields[`${key}.comment`]),
      order: Number(match[3])
    });
  }
  statements.sort(
    (a, b) =>
      (a.group < b.group ? -1 : Number(a.group > b.group)) ||
      (a.type < b.type ? -1 : Number(a.type > b.type)) ||
      a.order - b.order
  );
  return {
    pfp: nonEmpty(fields.avatar),
    banner1: nonEmpty(fields.banner1),
    banner2: nonEmpty(fields.banner2),
    website: nonEmpty(fields.website),
    classification: nonEmpty(fields.classification),
    subClassification: nonEmpty(fields.subClassification),
    statements: statements.map(({ order: _order, ...rest }) => rest)
  };
}

export const EMPTY_PROFILE_DOC_FIELDS: ProfileDocFields = {
  pfp: null,
  banner1: null,
  banner2: null,
  website: null,
  classification: null,
  subClassification: null,
  statements: []
};
