import { Json } from './waves-export.types';

/**
 * A tinyint column as MySQL drivers give it: a boolean, a number or its
 * text. Any value but 0 is true, as in MySQL.
 */
function flag(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  return Number(value) !== 0;
}

/** A drops row's columns that dropTableValues reads. */
export interface DropTableRow {
  readonly id: string;
  readonly signature: string | null;
  readonly is_additional_action_promised: unknown;
  readonly hide_link_preview: unknown;
  readonly collapse_replies: unknown;
  readonly drop_type: string;
  readonly reply_to_part_id: unknown;
}

/**
 * The drops table's own values the API shows differently or not at all
 * (waves-export.compact TABLE_KEYS), set on each exported drop as `table`.
 */
export function dropTableValues(row: DropTableRow): Json {
  const replyPart = row.reply_to_part_id;
  return {
    signature: row.signature ?? null,
    is_additional_action_promised: flag(row.is_additional_action_promised),
    hide_link_preview: flag(row.hide_link_preview) ?? false,
    collapse_replies: flag(row.collapse_replies) ?? false,
    drop_type: row.drop_type,
    reply_to_part_id:
      replyPart === null || replyPart === undefined ? null : Number(replyPart)
  };
}

/**
 * A page's drops, each with its table values as `table`. A drop the table
 * read didn't return fails the page (and so its wave) rather than going out
 * without them.
 */
export function withTableValues(
  drops: readonly Json[],
  tableOf: ReadonlyMap<string, Json>
): Json[] {
  const missing = drops.filter((drop) => !tableOf.has(String(drop.id)));
  if (missing.length) {
    throw new Error(
      `${missing.length} drops of a page have no drops table row (first ${String(
        missing[0].id
      )})`
    );
  }
  return drops.map((drop) => ({
    ...drop,
    table: tableOf.get(String(drop.id))!
  }));
}
