import { DROPS_TABLE, DROP_RELATIONS_TABLE } from '@/constants';

/** The relation table already records every ancestor, including the root. */
export function collapsedDropReplyExistsSql(dropAlias: string): string {
  return `exists (
    select 1
    from ${DROP_RELATIONS_TABLE} reply_relation
    join ${DROPS_TABLE} reply_root
      on reply_root.id = reply_relation.parent_id
      and reply_root.wave_id = reply_relation.wave_id
      and reply_root.collapse_replies = true
      and reply_root.reply_to_drop_id is null
    where reply_relation.child_id = ${dropAlias}.id
      and reply_relation.wave_id = ${dropAlias}.wave_id
  )`;
}
