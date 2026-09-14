import {
  ContextRecord,
  Json,
  ValueSchema
} from '../artwork-documentation.types';
import {
  fail,
  matchesSchema,
  normalizeJson
} from '../artwork-documentation.validation';
import { museumRecordDefinition } from './museum-record.catalogue';

export interface MuseumRecordInput {
  kind: string;
  title: string;
  effective_date?: string;
  event_status: 'planned' | 'completed' | 'cancelled' | 'unknown';
  statement?: string;
  subject_ids: string[];
  evidence_asset_ids: string[];
  details: Record<string, Json>;
  supersedes_id?: string;
}

const uuid: ValueSchema = { type: 'string', format: 'uuid' };
const ids: ValueSchema = {
  type: 'array',
  items: uuid,
  uniqueItems: true,
  maxItems: 100
};
const inputSchema: ValueSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'kind',
    'title',
    'event_status',
    'subject_ids',
    'evidence_asset_ids',
    'details'
  ],
  properties: {
    kind: { type: 'string', minLength: 1, maxLength: 40 },
    title: { type: 'string', minLength: 1, maxLength: 300 },
    effective_date: { type: 'string', format: 'partial-date' },
    event_status: {
      type: 'string',
      enum: ['planned', 'completed', 'cancelled', 'unknown']
    },
    statement: { type: 'string', maxLength: 50000 },
    subject_ids: ids,
    evidence_asset_ids: ids,
    details: { type: 'object', additionalProperties: true },
    supersedes_id: uuid
  }
};

export function museumEntityIds(context: ContextRecord): Set<string> {
  const result = new Set([
    context.work_id,
    ...context.asset_links.map((link) => link.asset_id)
  ]);
  const collect = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(collect);
      return;
    }
    const object = value as Record<string, unknown>;
    if (typeof object.id === 'string' && matchesSchema(object.id, uuid))
      result.add(object.id);
    Object.values(object).forEach(collect);
  };
  collect(context.modules);
  return result;
}

export function museumEvidenceIds(input: MuseumRecordInput): string[] {
  const result = new Set(input.evidence_asset_ids);
  for (const [key, value] of Object.entries(input.details)) {
    if (key.endsWith('_asset_id') && typeof value === 'string')
      result.add(value);
    if (key.endsWith('_asset_ids') && Array.isArray(value)) {
      value.forEach((id) => {
        if (typeof id === 'string') result.add(id);
      });
    }
  }
  return Array.from(result).sort((a, b) => a.localeCompare(b));
}

function validateAuthority(details: Record<string, Json>): void {
  const patterns: Record<string, RegExp> = {
    GETTY_TGN: /^http:\/\/vocab\.getty\.edu\/tgn\/(\d+)$/,
    GETTY_AAT: /^http:\/\/vocab\.getty\.edu\/aat\/(\d+)$/,
    GETTY_ULAN: /^http:\/\/vocab\.getty\.edu\/ulan\/(\d+)$/,
    VIAF: /^https?:\/\/viaf\.org\/viaf\/(\d+)\/?$/,
    WIKIDATA: /^https?:\/\/www\.wikidata\.org\/entity\/(Q\d+)$/
  };
  const match = patterns[String(details.authority)]?.exec(
    String(details.canonical_iri)
  );
  if (!match || match[1] !== details.identifier)
    fail(422, 'AUTHORITY_IDENTIFIER_MISMATCH');
  if (
    details.focus_iri &&
    (details.authority !== 'GETTY_TGN' ||
      details.focus_iri !== `${details.canonical_iri}-place`)
  )
    fail(422, 'AUTHORITY_FOCUS_MISMATCH');
}

export function validateMuseumRecord(
  input: unknown,
  context: ContextRecord
): MuseumRecordInput {
  const normalized = normalizeJson(input);
  if (
    Buffer.byteLength(JSON.stringify(normalized), 'utf8') > 150000 ||
    !matchesSchema(normalized, inputSchema)
  )
    fail(422, 'INVALID_MUSEUM_RECORD');
  const record = normalized as unknown as MuseumRecordInput;
  const definition = museumRecordDefinition(record.kind);
  if (!definition || !matchesSchema(record.details, definition.value_schema))
    fail(422, 'INVALID_MUSEUM_RECORD');
  const subjects = museumEntityIds(context);
  if (record.subject_ids.some((id) => !subjects.has(id)))
    fail(422, 'UNKNOWN_MUSEUM_SUBJECT');
  if (record.kind === 'authority_alignment') {
    validateAuthority(record.details);
    if (!subjects.has(String(record.details.entity_id)))
      fail(422, 'UNKNOWN_MUSEUM_SUBJECT');
  }
  if (
    record.kind === 'condition' &&
    ['finality_check', 'fixity_check', 'rendering_check'].some((key) =>
      ['verified', 'matches', 'differs', 'mismatch'].includes(
        String(record.details[key])
      )
    ) &&
    !record.details.verification_asset_id
  )
    fail(422, 'VERIFICATION_EVIDENCE_REQUIRED');
  return record;
}
