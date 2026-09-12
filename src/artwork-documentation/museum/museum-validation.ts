import {
  Answer,
  Answers,
  ContextRecord,
  Issue,
  Json,
  Modules
} from '../artwork-documentation.types';
import {
  answerValue,
  fail,
  validateDateObject
} from '../artwork-documentation.validation';
import { MEDIA_PROFILE_IDS, MediaProfileId } from './museum-record.types';

type ObjectValue = Record<string, Json>;
const objectValue = (value: Json | undefined): value is ObjectValue =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const rows = (answer?: Answer): ObjectValue[] =>
  answerValue<ObjectValue[]>(answer) ?? [];
const COLLECTIONS = [
  ['identity', 'agents'],
  ['artwork', 'components'],
  ['artwork', 'physical_objects'],
  ['artwork', 'places'],
  ['artwork', 'measurements'],
  ['artwork', 'relationships'],
  ['artwork', 'related_works'],
  ['artwork', 'inscriptions'],
  ['files', 'described_materials'],
  ['artwork', 'classifications'],
  ['artwork', 'external_identifiers'],
  ['artwork', 'token_references'],
  ['context', 'documents'],
  ['context', 'sources'],
  ['context', 'events'],
  ['rights', 'material_rights'],
  ['interview', 'sessions'],
  ['preservation', 'presentation_scenes']
] as const;

export function museumRequired(modules: Modules): string[] {
  return (answerValue<MediaProfileId[]>(modules.artwork.media_profiles) ?? [])
    .filter((id) => MEDIA_PROFILE_IDS.includes(id))
    .map((id) => `process.${id}`);
}

/** Every nested reference is checked by the existing linked/ready asset gate. */
export function museumAssetReferences(
  answers: Answers
): { field: string; id: string }[] {
  const result: { field: string; id: string }[] = [];
  function walk(value: Json, field: string): void {
    if (Array.isArray(value)) {
      value.forEach((item) => walk(item, field));
      return;
    }
    if (!objectValue(value)) return;
    for (const [key, item] of Object.entries(value)) {
      if (key.endsWith('asset_id') && typeof item === 'string') {
        result.push({ field, id: item });
      } else if (key.endsWith('asset_ids') && Array.isArray(item)) {
        for (const id of item)
          if (typeof id === 'string') result.push({ field, id });
      } else {
        walk(item, field);
      }
    }
  }
  for (const [field, answer] of Object.entries(answers)) {
    const value = answerValue(answer);
    if (value !== undefined) walk(value, field);
  }
  return result;
}

function validateNested(value: Json): void {
  if (Array.isArray(value)) {
    value.forEach(validateNested);
    return;
  }
  if (!objectValue(value)) return;
  if ('precision' in value && 'start' in value && !validateDateObject(value))
    fail(422, 'INVALID_DATE');
  if (
    typeof value.start_seconds === 'number' &&
    typeof value.end_seconds === 'number' &&
    value.end_seconds < value.start_seconds
  )
    fail(422, 'INVALID_TIME_RANGE');
  if (
    typeof value.source_start_seconds === 'number' &&
    typeof value.source_end_seconds === 'number' &&
    value.source_end_seconds < value.source_start_seconds
  )
    fail(422, 'INVALID_TIME_RANGE');
  if (value.kind === 'fixed' && !('seconds' in value))
    fail(422, 'DURATION_REQUIRED');
  if (value.unit === 'other' && !value.unit_label)
    fail(422, 'MEASUREMENT_NOTE_REQUIRED');
  if ('latitude' in value !== 'longitude' in value)
    fail(422, 'INCOMPLETE_COORDINATES');
  for (const item of Object.values(value)) validateNested(item);
}

function validateAuthorityClaims(value: Json): void {
  if (Array.isArray(value)) {
    value.forEach(validateAuthorityClaims);
    return;
  }
  if (!objectValue(value)) return;
  if (value.authority === 'TGN') {
    const expected = `http://vocab.getty.edu/tgn/${value.identifier}`;
    if (!/^\d+$/.test(String(value.identifier)) || value.uri !== expected)
      fail(422, 'INVALID_TGN_IDENTITY');
  }
  for (const item of Object.values(value)) validateAuthorityClaims(item);
}

export function validateMuseumDraft(context: ContextRecord): void {
  if (context.profile.version !== 3) return;
  const html = answerValue<ObjectValue>(context.modules.process.html);
  if (html && typeof html.entry_document === 'string') {
    const entry = html.entry_document;
    if (
      /^[\\/]|^[a-z]+:|[\\?#]/i.test(entry) ||
      Array.from(entry).some((character) => character.charCodeAt(0) < 32) ||
      entry.split('/').some((part) => !part || part === '.' || part === '..')
    )
      fail(422, 'INVALID_ENTRY_DOCUMENT');
  }
  const seen = new Set([context.work_id]);
  for (const [moduleId, field] of COLLECTIONS) {
    for (const item of rows(context.modules[moduleId][field])) {
      const id = String(item.id);
      if (
        seen.has(id) ||
        context.asset_links.some((asset) => asset.asset_id === id)
      )
        fail(422, 'DUPLICATE_MUSEUM_ID');
      seen.add(id);
    }
  }
  for (const scene of rows(context.modules.preservation.presentation_scenes)) {
    for (const annotation of (scene.annotations as ObjectValue[] | undefined) ??
      []) {
      const id = String(annotation.id);
      if (seen.has(id)) fail(422, 'DUPLICATE_MUSEUM_ID');
      seen.add(id);
    }
    for (const resource of [
      ...((scene.resources as ObjectValue[] | undefined) ?? []),
      ...((scene.annotations as ObjectValue[] | undefined) ?? [])
    ]) {
      if (
        typeof scene.duration_seconds === 'number' &&
        [resource.start_seconds, resource.end_seconds].some(
          (value) =>
            typeof value === 'number' &&
            value > (scene.duration_seconds as number)
        )
      )
        fail(422, 'PRESENTATION_TIME_OUT_OF_BOUNDS');
      if (
        typeof scene.width === 'number' &&
        typeof resource.x === 'number' &&
        typeof resource.width === 'number' &&
        resource.x + resource.width > scene.width
      )
        fail(422, 'PRESENTATION_REGION_OUT_OF_BOUNDS');
      if (
        typeof scene.height === 'number' &&
        typeof resource.y === 'number' &&
        typeof resource.height === 'number' &&
        resource.y + resource.height > scene.height
      )
        fail(422, 'PRESENTATION_REGION_OUT_OF_BOUNDS');
    }
  }
  for (const answers of Object.values(context.modules))
    for (const answer of Object.values(answers)) {
      const value = answerValue(answer);
      if (value !== undefined) {
        validateNested(value);
        validateAuthorityClaims(value);
      }
    }
}

function entityIds(context: ContextRecord): Map<string, string> {
  const ids = new Map<string, string>([[context.work_id, 'work']]);
  for (const link of context.asset_links) ids.set(link.asset_id, 'asset');
  for (const [moduleId, field] of COLLECTIONS)
    for (const row of rows(context.modules[moduleId][field]))
      ids.set(String(row.id), field);
  return ids;
}
const REFERENCE_KINDS: Record<string, string[] | null> = {
  subject_id: null,
  object_id: null,
  subject_ids: null,
  related_subject_ids: null,
  agent_id: ['agents'],
  speaker_agent_id: ['agents'],
  place_id: ['places'],
  source_ids: ['sources', 'documents'],
  transcript_document_id: ['documents'],
  component_ids: ['components', 'physical_objects'],
  interview_session_ids: ['sessions']
};

function relationshipIssues(
  context: ContextRecord,
  add: (path: string, code: string) => void
): void {
  const ids = entityIds(context);
  function walk(value: Json, path: string): void {
    if (Array.isArray(value)) {
      value.forEach((item) => walk(item, path));
      return;
    }
    if (!objectValue(value)) return;
    for (const [key, item] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(REFERENCE_KINDS, key)) {
        const allowed = REFERENCE_KINDS[key];
        for (const id of Array.isArray(item) ? item : [item]) {
          const kind = ids.get(String(id));
          if (!kind || (allowed && !allowed.includes(kind)))
            add(path, 'MUSEUM_REFERENCE_UNRESOLVED');
        }
      } else walk(item, path);
    }
  }
  for (const [moduleId, answers] of Object.entries(context.modules))
    for (const [field, answer] of Object.entries(answers)) {
      const value = answerValue(answer);
      if (value !== undefined) walk(value, `${moduleId}.${field}`);
    }
  for (const relation of rows(context.modules.artwork.relationships))
    if (relation.subject_id === relation.object_id)
      add('artwork.relationships', 'SELF_RELATIONSHIP');
  const graph = new Map<string, string[]>();
  for (const relation of rows(context.modules.artwork.relationships)) {
    if (
      ![
        'component_of',
        'version_of',
        'derived_from',
        'realization_of'
      ].includes(String(relation.relation))
    )
      continue;
    const from = String(relation.subject_id);
    graph.set(from, [...(graph.get(from) ?? []), String(relation.object_id)]);
  }
  const done = new Set<string>();
  const active = new Set<string>();
  const walkGraph = (id: string): boolean => {
    if (active.has(id)) return true;
    if (done.has(id)) return false;
    active.add(id);
    if ((graph.get(id) ?? []).some(walkGraph)) return true;
    active.delete(id);
    done.add(id);
    return false;
  };
  if (Array.from(graph.keys()).some(walkGraph))
    add('artwork.relationships', 'CYCLIC_MUSEUM_RELATIONSHIP');
}

function documentIssues(
  context: ContextRecord,
  add: (path: string, code: string) => void
): void {
  for (const scene of rows(context.modules.preservation.presentation_scenes)) {
    for (const annotation of (scene.annotations as ObjectValue[] | undefined) ??
      []) {
      if (!annotation.text && !annotation.asset_id)
        add('preservation.presentation_scenes', 'ANNOTATION_CONTENT_REQUIRED');
    }
  }
  for (const doc of rows(context.modules.context.documents)) {
    if (!doc.text && !doc.asset_id)
      add('context.documents', 'DOCUMENT_CONTENT_REQUIRED');
    if (
      ['machine_transcript', 'machine_translation'].includes(
        String(doc.authorship)
      ) &&
      doc.review_status !== 'author_reviewed'
    )
      add('context.documents', 'GENERATED_TEXT_REVIEW_REQUIRED');
  }
  for (const session of rows(context.modules.interview.sessions)) {
    if (
      !session.transcript_text &&
      !session.transcript_document_id &&
      !session.transcript_asset_id &&
      !(session.segments as Json[] | undefined)?.length
    )
      add('interview.sessions', 'INTERVIEW_TRANSCRIPT_REQUIRED');
    if (
      session.mode !== 'written' &&
      !(session.recording_asset_ids as Json[] | undefined)?.length
    )
      add('interview.sessions', 'INTERVIEW_RECORDING_REQUIRED');
    const instrument = session.instrument as ObjectValue;
    const questions = instrument.questions as ObjectValue[];
    const ids = new Set(questions.map((question) => question.id));
    if (ids.size !== questions.length)
      add('interview.sessions', 'DUPLICATE_INTERVIEW_QUESTION');
    const participants = new Set(
      (session.participants as ObjectValue[]).map((person) => person.agent_id)
    );
    for (const segment of (session.segments as ObjectValue[] | undefined) ??
      []) {
      if (!participants.has(segment.speaker_agent_id))
        add('interview.sessions', 'INTERVIEW_SPEAKER_UNRESOLVED');
      if (segment.question_id && !ids.has(segment.question_id))
        add('interview.sessions', 'INTERVIEW_QUESTION_UNRESOLVED');
    }
  }
}

export function museumRecordIssues(context: ContextRecord): Issue[] {
  if (context.profile.version !== 3) return [];
  const issues: Issue[] = [];
  const add = (field: string, code: string) =>
    issues.push({
      field,
      code,
      lane: field.startsWith('rights.') ? 'rights' : 'curatorial'
    });
  relationshipIssues(context, add);
  documentIssues(context, add);
  const profiles =
    answerValue<MediaProfileId[]>(context.modules.artwork.media_profiles) ?? [];
  for (const media of profiles)
    if (!answerValue(context.modules.process[media]))
      add(`process.${media}`, 'MEDIA_ACCOUNT_REQUIRED');
  const textWork = answerValue<ObjectValue>(context.modules.process.text);
  if (
    profiles.includes('text') &&
    textWork &&
    !textWork.authoritative_text &&
    !(textWork.source_asset_ids as Json[] | undefined)?.length
  )
    add('process.text', 'AUTHORITATIVE_TEXT_REQUIRED');
  const known = new Set(issues.map((issue) => `${issue.field}:${issue.code}`));
  return Array.from(known).map(
    (key) => issues.find((issue) => `${issue.field}:${issue.code}` === key)!
  );
}
