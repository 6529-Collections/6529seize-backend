import type { UserGroupsService } from '@/api/community-members/user-groups.service';
import { RequestContext } from '@/request.context';
import { ArtworkDocumentationDb } from './artwork-documentation.db';
import { emptyCapabilities } from './artwork-documentation.access';
import { AD_PROGRAM_VIEWERS } from './artwork-documentation.tables';
import { documentationViewerGroups } from './artwork-documentation.group-access';

export type ProgramViewerSubject = {
  subject_type: 'profile' | 'group';
  subject_id: string;
};
export type ProgramViewerRow = ProgramViewerSubject & {
  id: string;
  program_id: string;
  grantor_profile_id: string;
  created_at: number;
  revoked_at: number | null;
};
export type ProgramViewerGroups = Pick<
  UserGroupsService,
  'getGroupsUserIsEligibleForByIds'
>;

export function programViewerCapabilities() {
  return {
    ...emptyCapabilities(),
    read_context: true,
    read_archival_files: true,
    read_rights_evidence: true,
    read_source_receipts: true,
    read_contact: true,
    read_restricted_fields: true
  };
}

/** Resolve the current group criteria, never a copied membership roster. */
export async function readableViewerPrograms(
  db: ArtworkDocumentationDb,
  actor: string,
  ctx: RequestContext,
  programId?: string,
  groups: ProgramViewerGroups = documentationViewerGroups(db, ctx)
): Promise<string[]> {
  const rows = await db.query<ProgramViewerRow>(
    `SELECT program_id,subject_type,subject_id FROM ${AD_PROGRAM_VIEWERS} WHERE revoked_at IS NULL AND (subject_type='group' OR (subject_type='profile' AND subject_id=:actor))${programId ? ' AND program_id=:programId' : ''}`,
    { actor, programId },
    ctx
  );
  const directlyReadable = new Set(
    rows
      .filter(
        (row) => row.subject_type === 'profile' && row.subject_id === actor
      )
      .map((row) => row.program_id)
  );
  const groupIds = Array.from(
    new Set(
      rows
        .filter(
          (row) =>
            row.subject_type === 'group' &&
            !directlyReadable.has(row.program_id)
        )
        .map((row) => row.subject_id)
    )
  );
  const eligible = new Set(
    groupIds.length
      ? await groups.getGroupsUserIsEligibleForByIds(actor, groupIds, ctx.timer)
      : []
  );
  return Array.from(
    new Set(
      rows
        .filter(
          (row) =>
            (row.subject_type === 'profile' && row.subject_id === actor) ||
            (row.subject_type === 'group' && eligible.has(row.subject_id))
        )
        .map((row) => row.program_id)
    )
  );
}
