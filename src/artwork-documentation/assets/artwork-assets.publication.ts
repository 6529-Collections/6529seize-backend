import type {
  Answer,
  ContextRecord,
  Issue,
  Json
} from '@/artwork-documentation/artwork-documentation.types';

type Row = Record<string, Json>;
function rows(answer?: Answer): Row[] {
  return answer?.status === 'provided' &&
    answer.intended_visibility === 'public_record' &&
    Array.isArray(answer.value)
    ? answer.value.filter(
        (value): value is Row =>
          !!value && typeof value === 'object' && !Array.isArray(value)
      )
    : [];
}
function includes(value: Json | undefined, id: string): boolean {
  return Array.isArray(value) && value.includes(id);
}
function publicationUses(rights: Row[], id: string): Row[] {
  return rights
    .filter((right) => includes(right.subject_ids, id))
    .flatMap((right) =>
      Array.isArray(right.uses)
        ? right.uses.filter(
            (use): use is Row =>
              !!use &&
              typeof use === 'object' &&
              !Array.isArray(use) &&
              use.use === 'publication'
          )
        : []
    );
}
function sessionCovers(
  sessions: Row[],
  documents: Row[],
  id: string,
  role: string
): boolean {
  return sessions.some((session) => {
    if (session.publication_permission !== 'intended_public_record')
      return false;
    if (role === 'interview_recording')
      return includes(session.recording_asset_ids, id);
    return (
      session.transcript_asset_id === id ||
      includes(session.caption_asset_ids, id) ||
      documents.some(
        (document) =>
          document.id === session.transcript_document_id &&
          document.asset_id === id
      )
    );
  });
}

/** Draft uploads may precede the conversation. Confirmation/export require clearance of each exact file. */
export function interviewPublicationIssues(
  context: ContextRecord,
  additionalAssets: readonly { id: string; role: string }[] = []
): Issue[] {
  if (context.profile.version !== 3) return [];
  const sessions = rows(context.modules.interview.sessions);
  const documents = rows(context.modules.context.documents);
  const rights = rows(context.modules.rights.material_rights);
  const issues: Issue[] = [];
  const assets = interviewRoles(context, additionalAssets);
  for (const [id, roles] of Array.from(assets)) {
    const uses = publicationUses(rights, id);
    const denied = uses.some((use) => use.status === 'denied');
    const granted = uses.some(
      (use) =>
        use.status === 'granted' ||
        (use.status === 'granted_with_conditions' &&
          typeof use.conditions === 'string' &&
          !!use.conditions.trim())
    );
    if (
      denied ||
      (!granted &&
        !Array.from(roles).every((role) =>
          sessionCovers(sessions, documents, id, role)
        ))
    )
      issues.push({
        field: `asset:${id}`,
        code: 'INTERVIEW_PUBLICATION_PERMISSION_REQUIRED',
        lane: 'rights'
      });
  }
  return issues;
}

function interviewRoles(
  context: ContextRecord,
  additionalAssets: readonly { id: string; role: string }[]
): Map<string, Set<string>> {
  const roles = new Map<string, Set<string>>();
  const add = (id: string, role: unknown): void => {
    if (role !== 'interview_recording' && role !== 'interview_transcript')
      return;
    const values = roles.get(id) ?? new Set<string>();
    values.add(role);
    roles.set(id, values);
  };
  for (const link of context.asset_links) {
    add(link.asset_id, link.role);
    add(link.asset_id, link.manifest.role);
  }
  for (const asset of additionalAssets) add(asset.id, asset.role);
  return roles;
}
