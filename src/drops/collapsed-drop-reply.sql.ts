import { DROPS_TABLE, DROP_RELATIONS_TABLE } from '@/constants';

/** The relation table records every ancestor and indexes the child ID. */
export function collapsedDropReplyExistsSql(): string {
  return `exists (
    select 1
    from ${DROP_RELATIONS_TABLE} reply_relation
    join ${DROPS_TABLE} reply_root
      on reply_root.id = reply_relation.parent_id
      and reply_root.wave_id = reply_relation.wave_id
      and reply_root.collapse_replies = true
      and reply_root.reply_to_drop_id is null
    where reply_relation.child_id = d.id
      and reply_relation.wave_id = d.wave_id
  )`;
}
