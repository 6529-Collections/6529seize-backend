import { DELETED_DROPS_TABLE } from '@/constants';

export function competitionEntryVisibleSql(alias: string): string {
  return `(${alias}.status in ('ACTIVE', 'WINNER') and not exists (
    select 1 from ${DELETED_DROPS_TABLE} deleted where deleted.id = ${alias}.drop_id
  ))`;
}
