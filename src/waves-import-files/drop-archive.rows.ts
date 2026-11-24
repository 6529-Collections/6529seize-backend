import { DropType } from '@/entities/IDrop';

/**
 * A drop archive line (format v1, tools/legacy-snapshot README "The drop
 * archive") as 6529.io's `drops` and `drops_parts` rows. The line is the
 * public API's drop: ids, serial, times, type, title, parts, reply and
 * quotes are 6529.io's own values, so the rows take them as they are.
 *
 * The v1 line has no `signature`, `is_additional_action_promised`,
 * `hide_link_preview` or `collapse_replies`: a row gets the column's
 * default (null, null, false, false) unless the line carries the field.
 * The API shows a native competition entry's type COMPETITION as
 * PARTICIPATORY, a reply's null part id as 0, and a quote without a part
 * id not at all, so the rows hold those.
 */

export interface DropArchiveDropRow {
  readonly id: string;
  readonly serial_no: number;
  readonly wave_id: string;
  readonly author_id: string;
  readonly created_at: number;
  readonly updated_at: number | null;
  readonly title: string | null;
  readonly parts_count: number;
  readonly reply_to_drop_id: string | null;
  readonly reply_to_part_id: number | null;
  readonly drop_type: DropType;
  readonly signature: string | null;
  readonly is_additional_action_promised: boolean | null;
  readonly hide_link_preview: boolean;
  readonly collapse_replies: boolean;
}

export interface DropArchivePartRow {
  readonly drop_id: string;
  readonly drop_part_id: number;
  readonly content: string | null;
  readonly quoted_drop_id: string | null;
  readonly quoted_drop_part_id: number | null;
  readonly wave_id: string;
}

export const DROP_ROW_COLUMNS: readonly (keyof DropArchiveDropRow)[] = [
  'id',
  'serial_no',
  'wave_id',
  'author_id',
  'created_at',
  'updated_at',
  'title',
  'parts_count',
  'reply_to_drop_id',
  'reply_to_part_id',
  'drop_type',
  'signature',
  'is_additional_action_promised',
  'hide_link_preview',
  'collapse_replies'
];

export const PART_ROW_COLUMNS: readonly (keyof DropArchivePartRow)[] = [
  'drop_id',
  'drop_part_id',
  'content',
  'quoted_drop_id',
  'quoted_drop_part_id',
  'wave_id'
];

/** A line the reader refuses, with why (no content in the reason). */
export class DropArchiveLineError extends Error {
  constructor(message: string) {
    super(message);
    // The build targets ES5, where a subclass of Error loses its prototype.
    Object.setPrototypeOf(this, DropArchiveLineError.prototype);
  }
}

/** The drop types an archive line may name. */
const DROP_TYPES = new Set<string>([
  DropType.CHAT,
  DropType.PARTICIPATORY,
  DropType.WINNER,
  DropType.COMPETITION
]);

/** The width of 6529.io's id columns (varchar(100)). */
const ID_MAX = 100;
/** drops.title is varchar(250). */
const TITLE_MAX = 250;

/** A text's length as MySQL's utf8mb4 columns count it: code points. */
function characters(text: string): number {
  return Array.from(text).length;
}

type Json = Record<string, unknown>;

function fail(reason: string): never {
  throw new DropArchiveLineError(reason);
}

function object(value: unknown, what: string): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${what} is not an object`);
  }
  return value as Json;
}

function id(value: unknown, what: string): string {
  if (
    typeof value !== 'string' ||
    !value.length ||
    characters(value) > ID_MAX
  ) {
    fail(`${what} is not an id`);
  }
  return value;
}

function integer(value: unknown, what: string, min?: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    (min !== undefined && value < min)
  ) {
    fail(
      min === undefined
        ? `${what} is not an integer`
        : `${what} is not an integer of at least ${min}`
    );
  }
  return value;
}

/**
 * Any integer but 0: 6529.io holds a few drops with negative serials, and
 * drops.serial_no is an auto-increment key, which stores 0 as the next
 * number instead.
 */
function serialOf(value: unknown): number {
  const serial = integer(value, 'serial_no');
  if (serial === 0) fail('serial_no is 0, which the table would renumber');
  return serial;
}

function optional<T>(
  line: Json,
  key: string,
  check: (value: unknown) => value is T,
  fallback: T
): T {
  if (!(key in line)) return fallback;
  const value = line[key];
  if (!check(value)) fail(`${key} has the wrong type`);
  return value;
}

const isBoolean = (value: unknown): value is boolean =>
  typeof value === 'boolean';
const isNullableBoolean = (value: unknown): value is boolean | null =>
  value === null || typeof value === 'boolean';
const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === 'string';

/** A reply's or quote's part id: the API's integer, 0 for none given. */
function partRef(value: Json, what: string): number | null {
  const part = value.part_id;
  if (part === null) return null;
  return integer(part, what, 0);
}

/**
 * The rows of one archive line of the wave `legacyWave` (6529.io's wave
 * id). Throws DropArchiveLineError when the line is not a v1 drop of that
 * wave.
 */
export function dropArchiveRows(
  value: unknown,
  legacyWave: string
): { drop: DropArchiveDropRow; parts: DropArchivePartRow[] } {
  const line = object(value, 'the line');
  if (line.v !== 1) fail('the line is not format v1');
  const dropId = id(line.drop_id, 'drop_id');
  if (line.wave_id !== legacyWave) fail('the drop is of another wave');
  const dropType = line.drop_type;
  if (typeof dropType !== 'string' || !DROP_TYPES.has(dropType)) {
    fail('drop_type is not a drop type');
  }
  const title = line.title;
  if (
    !isNullableString(title) ||
    (title !== null && characters(title) > TITLE_MAX)
  ) {
    fail('title is not a title');
  }
  const updatedAt = line.updated_at;
  const replyTo =
    line.reply_to === null ? null : object(line.reply_to, 'reply_to');
  if (!Array.isArray(line.parts)) fail('parts is not a list');
  const parts = line.parts.map((value, index): DropArchivePartRow => {
    const part = object(value, `part ${index + 1}`);
    const content = part.content;
    if (!isNullableString(content)) fail(`part ${index + 1} content`);
    const quoted =
      part.quoted_drop === null
        ? null
        : object(part.quoted_drop, `part ${index + 1} quoted_drop`);
    return {
      drop_id: dropId,
      drop_part_id: integer(part.part_id, `part ${index + 1} part_id`, 1),
      content,
      quoted_drop_id: quoted
        ? id(quoted.drop_id, `part ${index + 1} quoted drop`)
        : null,
      quoted_drop_part_id: quoted
        ? partRef(quoted, `part ${index + 1} quoted part`)
        : null,
      wave_id: legacyWave
    };
  });
  const partIds = new Set(parts.map((part) => part.drop_part_id));
  if (partIds.size !== parts.length) fail('two parts share a part_id');
  const drop: DropArchiveDropRow = {
    id: dropId,
    serial_no: serialOf(line.serial_no),
    wave_id: legacyWave,
    author_id: id(line.author, 'author'),
    created_at: integer(line.created_at, 'created_at', 0),
    updated_at: updatedAt === null ? null : integer(updatedAt, 'updated_at', 0),
    title,
    parts_count: parts.length,
    reply_to_drop_id: replyTo ? id(replyTo.drop_id, 'reply_to drop') : null,
    reply_to_part_id: replyTo ? partRef(replyTo, 'reply_to part') : null,
    drop_type: dropType as DropType,
    signature: optional(line, 'signature', isNullableString, null),
    is_additional_action_promised: optional(
      line,
      'is_additional_action_promised',
      isNullableBoolean,
      null
    ),
    hide_link_preview: optional(line, 'hide_link_preview', isBoolean, false),
    collapse_replies: optional(line, 'collapse_replies', isBoolean, false)
  };
  return { drop, parts };
}
