/**
 * Profile documents: what a chain identity's profile says, kept off
 * the chain and named by CID. The chain holds only the CID; the gateway's
 * document store serves the bytes.
 *
 * ProfileDoc.v1 in the chain's canonical encoding, as the import writes it:
 *   string schema ("6529.ProfileDoc.v1") || bytes32 principal || uint32 version
 *   || bytes prev (<= 64) || bytes32 nonce
 *   || list<(string key, string value)> fields (keys ascending) || bytes sig
 * where string and bytes are `uint32 length || bytes` and a list is
 * `uint32 count || items`, all big-endian. A JSON object (`{"fields": {...}}`
 * or the fields themselves) is read too, for documents uploaded as JSON.
 */
export const PROFILE_DOC_SCHEMA = '6529.ProfileDoc.v1';

const MAX_FIELDS = 256;
const MAX_KEY = 128;
const MAX_VALUE = 65_536;

export interface ProfileDocStatement {
  readonly group: string;
  readonly type: string;
  readonly value: string;
  readonly comment: string | null;
}

/**
 * The profile site: three flat keys in the document,
 * `cms.primary.publication`, `cms.primary.package` and `cms.archive`, each a
 * raw-codec sha2-256 CIDv1 in base32 (`b` prefix). Publication and package
 * come together or not at all; only the import sets the archive.
 */
export interface ProfileDocCms {
  /** The site served at /{handle}/index.html; null: none. */
  readonly primary: {
    readonly publication: string;
    readonly package: string;
  } | null;
  /** The 6529.io site history as of the freeze; null: none. */
  readonly archive: string | null;
}

/** The 6529.io columns a profile document fills. */
export interface ProfileDocFields {
  /** The handle as its owner writes it (case kept). */
  readonly displayName: string | null;
  readonly pfp: string | null;
  readonly banner1: string | null;
  readonly banner2: string | null;
  readonly website: string | null;
  readonly classification: string | null;
  readonly subClassification: string | null;
  readonly statements: ProfileDocStatement[];
  /**
   * The profile site, rebuilt from its three keys in the shape the profile
   * site code reads; null: none (or only one of publication and package).
   * The profile site follower checks the files; the mirror only carries it.
   */
  readonly cms: ProfileDocCms | null;
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

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
/** CIDv1, codec raw (0x55), multihash sha2-256 (0x12) of 32 bytes. */
const CMS_CID_PREFIX = Buffer.from([0x01, 0x55, 0x12, 0x20]);
const CMS_CID_BYTES = CMS_CID_PREFIX.length + 32;
/** `b` and 58 base32 characters: 36 bytes. */
const CMS_CID_TEXT = /^b[a-z2-7]{58}$/;

/** Lower-case RFC 4648 base32, no padding. */
function toBase32(bytes: Buffer): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (let i = 0; i < bytes.length; i++) {
    value = ((value << 8) | bytes[i]) & 0xfff;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return bits > 0 ? out + BASE32[(value << (5 - bits)) & 31] : out;
}

/** The whole bytes of base32 text (spare trailing bits dropped); null if not base32. */
function fromBase32(text: string): Buffer | null {
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of text) {
    const index = BASE32.indexOf(char);
    if (index < 0) return null;
    value = ((value << 5) | index) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/**
 * A raw-codec sha2-256 CIDv1 in canonical base32 text (`bafkrei...`). The
 * last character carries two spare bits; text with them set names the same
 * bytes but is not canonical and is refused, as the profile site index
 * refuses it: the text must be what its bytes encode to.
 */
export function isCmsCid(text: string): boolean {
  if (!CMS_CID_TEXT.test(text)) return false;
  const bytes = fromBase32(text.slice(1));
  return (
    bytes !== null &&
    bytes.length === CMS_CID_BYTES &&
    bytes.subarray(0, CMS_CID_PREFIX.length).equals(CMS_CID_PREFIX) &&
    `b${toBase32(bytes)}` === text
  );
}

function cmsCid(value: string | undefined): string | null {
  return value !== undefined && isCmsCid(value) ? value : null;
}

/** The profile site from its three keys; a lone or malformed CID is left out. */
export function profileDocCms(
  fields: Record<string, string>
): ProfileDocCms | null {
  const publication = cmsCid(fields['cms.primary.publication']);
  const pkg = cmsCid(fields['cms.primary.package']);
  const archive = cmsCid(fields['cms.archive']);
  const primary = publication && pkg ? { publication, package: pkg } : null;
  return primary || archive ? { primary, archive } : null;
}

function nonEmpty(value: string | undefined): string | null {
  return value !== undefined && value.length > 0 ? value : null;
}

/**
 * The 6529.io columns from a document's fields. Statements are
 * `statement.<group>.<type>.<n>` with an optional `....<n>.comment`,
 * in n order within a group and type; `bio` is the first GENERAL/BIO
 * statement (the import writes it so).
 */
export function toProfileDocFields(
  fields: Record<string, string>
): ProfileDocFields {
  const statements: (ProfileDocStatement & { order: number })[] = [];
  if (fields.bio) {
    statements.push({
      group: 'GENERAL',
      type: 'BIO',
      value: fields.bio,
      comment: null,
      order: -1
    });
  }
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
    displayName: nonEmpty(fields.displayName),
    pfp: nonEmpty(fields.avatar),
    banner1: nonEmpty(fields.banner1),
    banner2: nonEmpty(fields.banner2),
    website: nonEmpty(fields.website),
    classification: nonEmpty(fields.classification),
    subClassification: nonEmpty(fields.subClassification),
    statements: statements.map(({ order: _order, ...rest }) => rest),
    cms: profileDocCms(fields)
  };
}

export const EMPTY_PROFILE_DOC_FIELDS: ProfileDocFields = {
  displayName: null,
  pfp: null,
  banner1: null,
  banner2: null,
  website: null,
  classification: null,
  subClassification: null,
  statements: [],
  cms: null
};
