import type { RequestContext } from '@/request.context';
import type { WaveBaseType } from '@/entities/IWave';
import { USER_GROUPS_TABLE } from '@/constants';
import { dbSupplier, type ConnectionWrapper } from '@/sql-executor';
import {
  membershipQueryOptions,
  withMembershipPrimaryMutationContext
} from './membership-primary';
import { isMembershipSourceTrackingActive } from './membership-producer-policy';
import { membershipCatalogueMutation } from './membership-producer-writes';
import { compareMembershipIds } from './membership-validation';
import {
  MEMBERSHIP_CATALOG_KEY,
  MembershipSourceStatesDb,
  type MembershipGroupChange
} from './membership-source-states.db';

export type RecordCatalogueSelection = (
  changes: readonly MembershipGroupChange[],
  reason: string
) => Promise<void>;

const membershipWaveGroupFields = [
  'visibility_group_id',
  'admin_group_id',
  'chat_group_id',
  'participation_group_id',
  'voting_group_id'
] as const;

export function membershipWaveGroupIds(
  wave: Pick<WaveBaseType, (typeof membershipWaveGroupFields)[number]>
): string[] {
  return Array.from(
    new Set(
      membershipWaveGroupFields.flatMap((field) =>
        wave[field] ? [wave[field]] : []
      )
    )
  );
}

/** A parent deletion can reference more than one catalogue mutation batch. */
export async function recordMembershipWaveSelection(
  record: RecordCatalogueSelection,
  groupIds: readonly (string | null | undefined)[],
  reason: string
): Promise<void> {
  const ids = Array.from(
    new Set(groupIds.filter((id): id is string => !!id))
  ).sort(compareMembershipIds);
  for (let offset = 0; offset < ids.length; offset += 128) {
    await record(
      ids.slice(offset, offset + 128).map((group_id) => ({
        group_id,
        is_deleted: false
      })),
      reason
    );
  }
}

/**
 * Lock the global catalogue source before a writer locks wave/curation rows.
 * The caller records changed group references after its authoritative SQL
 * writes, while still inside the same caller-owned transaction. A rollback
 * removes the input change, source version, group versions and request together.
 */
export async function withMembershipCatalogueSelection<T>(
  connection: ConnectionWrapper<unknown>,
  work: (record: RecordCatalogueSelection) => Promise<T>,
  ctx: RequestContext = {}
): Promise<T> {
  if (!isMembershipSourceTrackingActive()) {
    return work(async () => undefined);
  }
  return withMembershipPrimaryMutationContext(
    connection,
    async (primary) => {
      const sources = new MembershipSourceStatesDb(dbSupplier);
      await sources.capture([MEMBERSHIP_CATALOG_KEY], true, primary);
      return work(async (changes, reason) => {
        // A wave can outlive the group it referenced. Do not resurrect that
        // group's tombstone while removing the stale wave reference.
        const existing = new Set(
          (
            await dbSupplier().execute<{ id: string }>(
              `SELECT id FROM ${USER_GROUPS_TABLE} WHERE id IN (:ids)`,
              { ids: changes.map(({ group_id }) => group_id) },
              membershipQueryOptions(primary)
            )
          ).map(({ id }) => id)
        );
        await sources.mutate(
          membershipCatalogueMutation(
            changes.map(({ group_id }) => ({
              group_id,
              is_deleted: !existing.has(group_id)
            })),
            reason
          ),
          async () => undefined,
          primary
        );
      });
    },
    ctx
  );
}
