import { Answer, Answers, DocumentationProfile, FieldDefinition, Json, ModuleId, MODULE_IDS, Operation, ValueSchema } from './artwork-documentation.types';
import { answerValue, fail, matchesSchema, normalizeJson, validateDateObject } from './artwork-documentation.validation';

const text = (maxLength: number, format?: string): ValueSchema => ({ type: 'string', minLength: 1, maxLength, ...(format ? { format } : {}) });
const choice = (...values: string[]): ValueSchema => ({ type: 'string', enum: values });
const array = (items: ValueSchema, maxItems = 30, minItems = 0): ValueSchema => ({ type: 'array', items, maxItems, minItems });
const object = (properties: Record<string, ValueSchema>, required = Object.keys(properties)): ValueSchema => ({ type: 'object', properties, required, additionalProperties: false });
const number = (maximum = 1000000): ValueSchema => ({ type: 'integer', minimum: 1, maximum });
const bool: ValueSchema = { type: 'boolean' };
const url = text(2048, 'uri');
const uuid = text(36, 'uuid');
const language = text(64, 'bcp47');
const date = object({ precision: choice('day', 'month', 'year', 'range'), endpoint_precision: choice('day', 'month', 'year'), start: text(10, 'partial-date'), end: text(10, 'partial-date'), approximate: bool }, ['precision', 'start', 'approximate']);
const kindDetail = (kinds: string[], limit: number): ValueSchema => object({ kind: choice(...kinds), detail: text(limit) }, ['kind']);
const localized = (limit: number): ValueSchema => object({ primary_language: language, versions: array(object({ language, text: text(limit), authorship: choice('original', 'artist_translation', 'third_party_translation'), approved_by_artist: bool }), 10, 1) });
const reference = object({ label: text(160), url, note: text(1000) }, ['url']);
const availability = (kinds: string[]): ValueSchema => object({ kind: choice(...kinds), explanation: text(1000) }, ['kind']);
const participant = object({ name: text(160), role: text(300) });
const schemas: Record<ModuleId, Record<string, ValueSchema>> = {
  identity: {
    display_name: text(160), preferred_credit: text(300), biography: localized(4000),
    links: array(object({ label: text(100), url }), 10), languages: array(language, 10, 1), private_contact: text(320), record_language: language
  },
  artwork: {
    title: text(255), title_language: language, alternate_titles: array(object({ language, text: text(255) }), 10), capture_date: date, completion_date: date,
    location: text(300), medium: kindDetail(['digital_photograph', 'analogue_photograph', 'photographic_composite', 'other'], 500), edition_statement: text(500), visual_description: text(1500), series_title: text(255), canonical_asset_id: uuid,
    declared_dimensions: object({ width: number(), height: number() }),
    work_relationships: array(object({ work_id: uuid, source_url: url, relation: choice('version_of', 'part_of_series', 'related_work') }, ['relation']))
  },
  files: { master_availability: availability(['supplied', 'same_as_final', 'unavailable']), source_availability: availability(['supplied', 'retained_by_artist', 'unavailable', 'not_applicable']) },
  context: {
    caption: localized(3000), artist_statement: localized(12000), making_context: text(6000),
    theme_connection: { oneOf: [object({ kind: choice('text'), text: text(4000) }), object({ kind: choice('caption_reference') })] },
    misunderstandings: text(4000), references: array(reference),
    history: object({ kind: choice('entries_supplied', 'none_known', 'unknown'), entries: array(object({ kind: choice('publication', 'exhibition', 'award', 'print_edition', 'nft_mint', 'other'), scope: choice('this_work', 'series', 'artist'), title: text(300), date, venue: text(300), url, note: text(1000), chain: text(100), contract: text(100), token: text(100) }, ['kind', 'scope', 'title']), 50) }, ['kind']),
    prior_mint_status: object({ kind: choice('never_minted', 'previously_minted', 'unknown'), references: array(reference), explanation: text(1000) }, ['kind'])
  },
  process: {
    capture_method: kindDetail(['digital_camera', 'phone', 'drone', 'film_scan', 'other'], 500), camera: text(300), lens: text(300), exposure_note: text(500),
    techniques: object({ kinds: array(choice('single_capture', 'staged', 'composite', 'collage', 'focus_stack', 'long_exposure', 'miniature', 'other'), 9, 1), other_detail: text(500) }, ['kinds']),
    editing_tools: array(object({ name: text(160), version: text(100) }, ['name']), 20), process_description: text(8000), material_changes: text(4000), ai_use: kindDetail(['none', 'assistive', 'generative', 'unknown'], 4000),
    ingredients: object({ kind: choice('entries_supplied', 'unavailable'), entries: array(object({ asset_id: uuid, source_url: url, creator: text(160), role: text(300), rights_note: text(1000) }, ['creator', 'role', 'rights_note']), 50), explanation: text(1000) }, ['kind', 'entries']),
    contributors: object({ kind: choice('entries_supplied', 'none'), entries: array(object({ name: text(160), profile_id: text(100), role: text(300), authorship_claim: bool, credit: text(500) }, ['name', 'role', 'authorship_claim', 'credit']), 30) }), construction_note: text(4000)
  },
  rights: {
    rights_basis: kindDetail(['artist_owned', 'coauthored', 'licensed_components', 'other', 'unknown'], 2000), intended_license: object({ uri: url, label: text(160) }), rights_declaration: text(6000), declaration_effect: choice('proposed', 'conditional', 'already_effective', 'unknown'),
    third_party_material: object({ kind: choice('none', 'present', 'unknown'), details: text(4000), references: array(reference) }, ['kind']), people_depicted: choice('none', 'self_only', 'adults', 'includes_minors', 'uncertain'),
    consent_status: choice('not_applicable', 'documents_supplied', 'exists_not_supplied', 'not_available', 'uncertain'), consent_asset_ids: array(uuid, 30, 1), identifiability_note: text(2000), sensitive_context_note: text(4000), publication_notes: text(2000)
  },
  preservation: { significant_properties: text(6000), display_orientation_crop: text(2000), color_and_tone: text(2000), screen_preferences: text(2000), print_preferences: text(3000), acceptable_changes: text(4000), avoid_changes: text(4000), physical_materials: text(2000) },
  interview: {
    mode: choice('written', 'recording', 'declined', 'not_yet'), instrument_id: choice('artwork-documentation-artist-interview-v1'), instrument_version: { type: 'integer', enum: [1] }, date, participants: array(participant), languages: array(language, 10, 1),
    ...Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`q${index + 1}`, localized(8000)])),
    recording_asset_id: uuid, transcript_asset_id: uuid, recording_permission: choice('not_requested', 'private_review', 'intended_public_record'), transcript_permission: choice('not_requested', 'private_review', 'intended_public_record'), correction_note: text(4000)
  }
};
export const LOCKED_RESTRICTED = ['identity.private_contact', 'rights.people_depicted', 'rights.consent_status', 'rights.consent_asset_ids', 'rights.identifiability_note', 'rights.sensitive_context_note'];
const unknownAllowed = ['artwork.capture_date', 'artwork.completion_date', 'artwork.location', 'process.capture_method', 'process.camera', 'process.lens', 'interview.date'];
export const FIELD_CATALOGUE: Record<ModuleId, FieldDefinition[]> = Object.fromEntries(MODULE_IDS.map(moduleId => [moduleId, Object.entries(schemas[moduleId]).map(([id, value_schema]) => {
  const path = `${moduleId}.${id}`;
  const locked = LOCKED_RESTRICTED.includes(path);
  const statuses: Answer['status'][] = ['provided'];
  if (unknownAllowed.includes(path)) statuses.push('unknown');
  if (path === 'artwork.location') statuses.push('withheld');
  return { id, value_schema, allowed_statuses: statuses, default_visibility: locked ? 'restricted' : 'public_record', locked_restricted: locked };
})])) as Record<ModuleId, FieldDefinition[]>;

const PHOTOGRAPHY_REQUIRED = ['identity.display_name', 'identity.preferred_credit', 'identity.record_language', 'artwork.title', 'artwork.title_language', 'artwork.capture_date', 'artwork.location', 'artwork.medium', 'artwork.edition_statement', 'artwork.canonical_asset_id', 'files.master_availability', 'context.caption', 'context.history', 'context.prior_mint_status', 'process.capture_method', 'process.techniques', 'process.process_description', 'process.material_changes', 'process.ai_use', 'process.contributors', 'rights.rights_basis', 'rights.intended_license', 'rights.rights_declaration', 'rights.declaration_effect', 'rights.third_party_material', 'rights.people_depicted', 'preservation.significant_properties', 'preservation.display_orientation_crop', 'preservation.color_and_tone', 'preservation.acceptable_changes'];
export const CONFIRMATION_COPY_VERSION = 'artwork-documentation-confirmation-v1';
export const CONFIRMATION_COPY = 'I have reviewed this version. It reflects my account of the work to the best of my knowledge, including any uncertainty I have recorded. I have checked the credits, selected files and information marked for a future public record.';
export const DOCUMENTATION_LIMITS = { context_payload_bytes: 262144, write_request_bytes: 524288, asset_bytes: 4294967296, context_stored_and_reserved_bytes: 21474836480, assets_per_context: 100, upload_sessions_per_context: 5, upload_part_bytes: 16777216, client_parallel_parts: 3, upload_session_seconds: 86400, part_url_seconds: 600, download_url_seconds: 300, unattached_ready_asset_seconds: 604800 };
export const PROFILES: DocumentationProfile[] = ['stream_artwork_basic_v1', 'photography_documentation_v1', 'keys_and_gates_v1'].map(profile_id => ({
  profile_id, version: 1, program_id: profile_id === 'keys_and_gates_v1' ? '6529NM-AP-01' : null, wave_id: profile_id === 'keys_and_gates_v1' ? '4ff022b3-aa17-4a0a-ba78-58f64ff1d427' : null,
  required_for_review: profile_id === 'stream_artwork_basic_v1' ? ['identity.display_name', 'identity.preferred_credit', 'identity.record_language', 'artwork.title', 'artwork.title_language', 'artwork.canonical_asset_id', 'context.caption', 'rights.rights_basis', 'rights.intended_license', 'rights.rights_declaration', 'rights.declaration_effect'] : [...PHOTOGRAPHY_REQUIRED, ...(profile_id === 'keys_and_gates_v1' ? ['context.theme_connection'] : [])],
  review_lanes: ['curatorial', 'technical', 'rights'], modules: MODULE_IDS.map(id => ({ id, version: 1, fields: FIELD_CATALOGUE[id] })), guidance_version: 'artwork-documentation-copy-v1', confirmation_copy_version: CONFIRMATION_COPY_VERSION, confirmation_copy: CONFIRMATION_COPY, limits: DOCUMENTATION_LIMITS,
  storage_mode: 'private_database_and_object_storage', submission_gate: 'optional', group_order: ['artwork', 'story', 'artist', 'rights', 'preservation', 'review']
}));

export function getProfile(id: unknown, version: unknown): DocumentationProfile {
  const profile = PROFILES.find(item => item.profile_id === id && item.version === version);
  if (!profile) fail(422, 'UNSUPPORTED_PROFILE');
  return JSON.parse(JSON.stringify(profile));
}
export function emptyModules(): Record<ModuleId, Answers> { return Object.fromEntries(MODULE_IDS.map(id => [id, {}])) as Record<ModuleId, Answers>; }

export function applyOperations(moduleId: ModuleId, previous: Answers, operations: Operation[]): Answers {
  if (!MODULE_IDS.includes(moduleId) || !Array.isArray(operations) || !operations.length || operations.length > 100) fail(422, 'INVALID_OPERATIONS');
  const result = { ...previous };
  const seen = new Set<string>();
  for (const operation of operations) {
    const definition = FIELD_CATALOGUE[moduleId].find(field => field.id === operation.field);
    if (!definition || seen.has(operation.field) || !['set', 'unset'].includes(operation.op)) fail(422, 'INVALID_FIELD');
    seen.add(operation.field);
    if (operation.op === 'unset') {
      if (operation.answer !== undefined) fail(422, 'INVALID_ANSWER');
      delete result[operation.field];
    } else result[operation.field] = validateAnswer(moduleId, definition, operation.answer);
  }
  return result;
}

function validateAnswer(moduleId: ModuleId, definition: FieldDefinition, raw: unknown): Answer {
  const normalized = normalizeJson(raw);
  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) fail(422, 'INVALID_ANSWER');
  const answer = normalized as unknown as Answer;
  if (Object.keys(answer).some(key => !['status', 'value', 'explanation', 'intended_visibility'].includes(key)) || !definition.allowed_statuses.includes(answer.status) || !['public_record', 'restricted'].includes(answer.intended_visibility)) fail(422, 'INVALID_ANSWER');
  if (definition.locked_restricted && answer.intended_visibility !== 'restricted') fail(422, 'RESTRICTED_VISIBILITY_REQUIRED');
  if (answer.explanation !== undefined && !matchesSchema(answer.explanation, text(1000))) fail(422, 'INVALID_ANSWER');
  if (answer.status !== 'provided') {
    if (answer.value !== undefined || (moduleId === 'process' && definition.id === 'capture_method' && !answer.explanation)) fail(422, 'INVALID_ANSWER');
    return answer;
  }
  if (!matchesSchema(answer.value, definition.value_schema)) fail(422, 'INVALID_VALUE');
  validateSuppliedObject(`${moduleId}.${definition.id}`, answer.value!);
  return answer;
}

function validateSuppliedObject(path: string, value: Json): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const item = value as Record<string, Json>;
  const kind = item.kind;
  if ('precision' in item && !validateDateObject(item)) fail(422, 'INVALID_DATE');
  if ('versions' in item) validateLocalized(item);
  if ((kind === 'other' && !item.detail) || (path === 'process.ai_use' && ['assistive', 'generative'].includes(kind as string) && !item.detail) || (path === 'rights.rights_basis' && kind !== 'artist_owned' && !item.detail)) fail(422, 'DETAIL_REQUIRED');
  if (path === 'process.techniques') {
    const kinds = item.kinds as string[];
    if (new Set(kinds).size !== kinds.length || (kinds.includes('other') && !item.other_detail)) fail(422, 'DETAIL_REQUIRED');
  }
  if (['process.contributors', 'process.ingredients', 'context.history'].includes(path)) validateEntries(path, item);
  if (path.startsWith('files.') && ['unavailable', 'retained_by_artist', 'not_applicable'].includes(kind as string) && !item.explanation) fail(422, 'EXPLANATION_REQUIRED');
  if (path === 'context.prior_mint_status' && kind === 'previously_minted' && !(item.references as Json[] | undefined)?.length && !item.explanation) fail(422, 'EXPLANATION_REQUIRED');
  if (path === 'rights.third_party_material' && kind === 'present' && !item.details) fail(422, 'DETAIL_REQUIRED');
}

function validateEntries(path: string, item: Record<string, Json>): void {
  const entries = item.entries as Record<string, Json>[] | undefined;
  if (item.kind === 'entries_supplied' ? !entries?.length : !!entries?.length) fail(422, 'INVALID_ENTRIES');
  if (path === 'process.ingredients' && item.kind === 'unavailable' && !item.explanation) fail(422, 'EXPLANATION_REQUIRED');
  if (path === 'context.history') for (const entry of entries ?? []) if (entry.date && !validateDateObject(entry.date as Record<string, unknown>)) fail(422, 'INVALID_DATE');
}
function validateLocalized(item: Record<string, Json>): void {
  const versions = item.versions as Record<string, Json>[];
  const languages = versions.map(version => version.language);
  if (!languages.includes(item.primary_language) || new Set(languages).size !== languages.length || versions.filter(version => version.authorship === 'original').length !== 1) fail(422, 'INVALID_TRANSLATIONS');
}
export function getAnswer(modules: Record<ModuleId, Answers>, path: string): Answer | undefined {
  const [moduleId, field] = path.split('.');
  return modules[moduleId as ModuleId]?.[field];
}
export function conditionalRequired(modules: Record<ModuleId, Answers>): string[] {
  const paths: string[] = [];
  const techniques = answerValue<{ kinds: string[] }>(modules.process.techniques)?.kinds ?? [];
  if (techniques.includes('composite') || techniques.includes('collage')) paths.push('process.ingredients');
  if (techniques.includes('miniature')) paths.push('process.construction_note');
  const people = answerValue<string>(modules.rights.people_depicted);
  if (people && people !== 'none') paths.push('rights.consent_status');
  if (['includes_minors', 'uncertain'].includes(people ?? '')) paths.push('rights.identifiability_note');
  if (answerValue(modules.rights.consent_status) === 'documents_supplied') paths.push('rights.consent_asset_ids');
  return paths;
}
