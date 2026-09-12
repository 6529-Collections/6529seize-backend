import { createHash } from 'node:crypto';
import { canonicalizeJson } from '@/profile-cms/protocol/v1/canonical-json';
import { parseJson } from '../../artwork-documentation.db';
import {
  ContextRecord,
  Json,
  ModuleId
} from '../../artwork-documentation.types';
import {
  answerValue,
  digest,
  normalizeJson
} from '../../artwork-documentation.validation';
import {
  MuseumAgent,
  MuseumAttribution,
  MuseumComponent,
  MuseumDate,
  MuseumDocument,
  MuseumEvent,
  MuseumExternalIdentifier,
  MuseumInterviewSession,
  MuseumMeasurement,
  MuseumPhysicalObject,
  MuseumPlace,
  MuseumRelationship
} from '../museum-record.types';
import { museumRecordIssues } from '../museum-validation';
import pinnedContext from './schema/linked-art-context.json';

type Entity = { id: string; type: string; [key: string]: Json };
type Coverage = {
  source_pointer: string;
  disposition: 'projected_with_source_retained' | 'retained_stream_only';
  rule: string;
};
type ClaimSource = { source_pointers: string[]; rule: string };
const CONTEXT = 'https://linked.art/ns/v1/linked-art.json';
const sha256 = (bytes: string) =>
  createHash('sha256').update(bytes, 'utf8').digest('hex');
const TYPES = {
  Person: 'crm:E21_Person',
  Actor: 'crm:E39_Actor',
  Group: 'crm:E74_Group',
  HumanMadeObject: 'crm:E22_Human-Made_Object',
  VisualItem: 'crm:E36_Visual_Item',
  LinguisticObject: 'crm:E33_Linguistic_Object',
  InformationObject: 'crm:E73_Information_Object',
  DigitalObject: 'dig:D1_Digital_Object',
  Place: 'crm:E53_Place',
  Activity: 'crm:E7_Activity',
  Creation: 'crm:E65_Creation',
  Production: 'crm:E12_Production',
  AttributeAssignment: 'crm:E13_Attribute_Assignment',
  Name: 'crm:E33_E41_Linguistic_Appellation',
  Identifier: 'crm:E42_Identifier',
  Dimension: 'crm:E54_Dimension',
  MeasurementUnit: 'crm:E58_Measurement_Unit',
  Type: 'crm:E55_Type',
  Material: 'crm:E57_Material',
  Language: 'crm:E56_Language',
  TimeSpan: 'crm:E52_Time-Span'
};

/** This is a locked draft archival projection, not a registered Stream schema or HTTP API. */
export const LINKED_ART_PROFILE_LOCK = {
  id: 'stream-museum-linked-art-draft-1',
  status: 'draft',
  cidoc_crm: '7.1.3',
  linked_art_model: '1.0.0',
  json_ld: '1.1',
  context_uri: CONTEXT,
  context_retrieved_at: '2026-09-12',
  context_download_sha256:
    '3017421203aba8ea73f159aced1285e35b37cee49b5648cf19b01f237025f165',
  context_canonical_sha256: sha256(canonicalizeJson(pinnedContext)),
  context_canonicalization: 'RFC8785',
  class_mappings: TYPES,
  http_api_conformance: false,
  projection_policy:
    'Artist-supplied direct facts; no authority equivalences from unreviewed draft alignments. Nonlinguistic E73 content remains in the CRM extension graph.'
};

function urn(id: string): string {
  return `urn:uuid:${id.toLowerCase()}`;
}
function derivedId(subject: string, path: string): string {
  const bytes = createHash('sha256').update(`${subject}\u0000${path}`).digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString('hex');
  return urn(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  );
}
const ref = (entity: Entity): Entity => ({
  id: entity.id,
  type: entity.type,
  ...(entity._label ? { _label: entity._label } : {})
});
const pointer = (moduleId: string, field: string) =>
  `/modules/${moduleId}/${field}/value`;
function labelEntity(id: string, type: string, label: string): Entity {
  return {
    id,
    type,
    _label: label,
    identified_by: [{ id: derivedId(id, 'name'), type: 'Name', content: label }]
  };
}
function statement(id: string, content: string, language?: string): Entity {
  return {
    id,
    type: 'LinguisticObject',
    content,
    ...(language
      ? {
          language: [
            {
              id: `urn:ietf:bcp:47:${language}`,
              type: 'Language',
              _label: language
            }
          ]
        }
      : {})
  };
}
function dateBound(partial: string, end: boolean): string {
  const parts = partial.split('-').map(Number);
  const year = parts[0];
  const month = parts[1] ?? 1;
  const day = parts[2] ?? 1;
  const value = new Date(0);
  value.setUTCFullYear(year, month - 1, day);
  value.setUTCHours(0, 0, 0, 0);
  if (end) {
    if (parts.length === 1) value.setUTCFullYear(year + 1);
    else if (parts.length === 2) value.setUTCMonth(month);
    else value.setUTCDate(day + 1);
  }
  return value.toISOString();
}
function timespan(id: string, date: MuseumDate): Entity {
  const label = `${date.approximate ? 'Approximately ' : ''}${date.start}${date.end ? `–${date.end}` : ''}${date.note ? ` (${date.note})` : ''}`;
  const value = labelEntity(derivedId(id, 'timespan'), 'TimeSpan', label);
  // Approximation has no known numeric tolerance. Preserve its expression without inventing bounds.
  if (!date.approximate) {
    value.begin_of_the_begin = dateBound(date.start, false);
    value.end_of_the_end = dateBound(date.end ?? date.start, true);
  }
  return value;
}
function append(entity: Entity, property: string, value: Json): void {
  entity[property] = [
    ...((entity[property] as Json[] | undefined) ?? []),
    value
  ];
}

class Projection {
  readonly entities = new Map<string, Entity>();
  readonly sources = new Map<string, ClaimSource[]>();
  readonly mapped = new Map<string, string>();
  readonly ambiguousActivities = new Set<string>();
  constructor(
    readonly context: ContextRecord,
    readonly museumRecords: Record<string, Json>[] = []
  ) {}
  add(entity: Entity, sourcePointer: string, rule: string): Entity {
    this.entities.set(entity.id, entity);
    this.mark(entity, sourcePointer, rule);
    return entity;
  }
  mark(entity: Entity, sourcePointer: string, rule: string): void {
    const found = sourcePointer
      .split('/')
      .filter(Boolean)
      .reduce<unknown>(
        (value, key) =>
          value && typeof value === 'object'
            ? (value as Record<string, unknown>)[key]
            : undefined,
        { ...this.context, museum_records: this.museumRecords }
      );
    if (found === undefined) sourcePointer = '/work_id';
    const sources = this.sources.get(entity.id) ?? [];
    sources.push({ source_pointers: [sourcePointer], rule });
    this.sources.set(entity.id, sources);
    this.mapped.set(sourcePointer, rule);
  }
  get(id: string): Entity | undefined {
    return this.entities.get(urn(id));
  }
  activity(
    subject: Entity,
    property: 'created_by' | 'produced_by',
    event: Entity
  ): void {
    const key = `${subject.id}:${property}`;
    if (this.ambiguousActivities.has(key)) return;
    if (subject[property] && (subject[property] as Entity).id !== event.id) {
      delete subject[property];
      this.ambiguousActivities.add(key);
    } else subject[property] = ref(event);
  }
  actors(credits: MuseumAttribution[] = []): Entity[] {
    return credits
      .map((credit) => this.get(credit.agent_id))
      .filter(
        (actor): actor is Entity =>
          !!actor && ['Person', 'Group'].includes(actor.type)
      )
      .map(ref);
  }
}

function workType(context: ContextRecord): string {
  const profiles =
    answerValue<string[]>(context.modules.artwork.media_profiles) ?? [];
  if (
    profiles.length &&
    profiles.every((profile) =>
      ['photography', 'digital_art'].includes(profile)
    )
  )
    return 'VisualItem';
  if (profiles.length === 1 && profiles[0] === 'text')
    return 'LinguisticObject';
  return 'InformationObject';
}
function componentType(component: MuseumComponent): string {
  if (component.kind === 'visual_content') return 'VisualItem';
  if (component.kind === 'text_content') return 'LinguisticObject';
  return 'InformationObject';
}
function seedEntities(projection: Projection): Entity {
  const context = projection.context;
  const title =
    answerValue<string>(context.modules.artwork.title) ?? 'Untitled draft';
  const work = projection.add(
    labelEntity(urn(context.work_id), workType(context), title),
    pointer('artwork', 'title'),
    'work-identity-and-title'
  );
  projection.mark(
    work,
    pointer('artwork', 'media_profiles'),
    'evidenced-content-type'
  );
  const titleLanguage = answerValue<string>(
    context.modules.artwork.title_language
  );
  if (titleLanguage) {
    (work.identified_by as Entity[])[0].language = [
      {
        id: `urn:ietf:bcp:47:${titleLanguage}`,
        type: 'Language',
        _label: titleLanguage
      }
    ];
    projection.mark(
      work,
      pointer('artwork', 'title_language'),
      'title-language'
    );
  }
  for (const alternate of answerValue<{ text: string; language: string }[]>(
    context.modules.artwork.alternate_titles
  ) ?? []) {
    append(work, 'identified_by', {
      id: derivedId(
        work.id,
        `alternate-title:${alternate.language}:${alternate.text}`
      ),
      type: 'Name',
      content: alternate.text,
      language: [
        {
          id: `urn:ietf:bcp:47:${alternate.language}`,
          type: 'Language',
          _label: alternate.language
        }
      ]
    });
    projection.mark(
      work,
      pointer('artwork', 'alternate_titles'),
      'alternate-title'
    );
  }
  for (const identifier of answerValue<MuseumExternalIdentifier[]>(
    context.modules.artwork.external_identifiers
  ) ?? []) {
    append(work, 'identified_by', {
      id: urn(identifier.id),
      type: 'Identifier',
      content: identifier.identifier,
      classified_as: [
        {
          id: derivedId(
            'stream-museum-identifier-namespace',
            identifier.namespace
          ),
          type: 'Type',
          _label: identifier.namespace
        }
      ]
    });
    projection.mark(
      work,
      pointer('artwork', 'external_identifiers'),
      'attributed-external-identifier'
    );
  }
  const text = answerValue<{
    authoritative_text?: string;
    languages?: string[];
  }>(context.modules.process.text);
  if (work.type === 'LinguisticObject' && text?.authoritative_text) {
    work.content = text.authoritative_text;
    if (text.languages?.length)
      work.language = text.languages.map((language) => ({
        id: `urn:ietf:bcp:47:${language}`,
        type: 'Language',
        _label: language
      }));
    projection.mark(
      work,
      pointer('process', 'text'),
      'authoritative-artwork-text'
    );
  }
  for (const agent of answerValue<MuseumAgent[]>(
    context.modules.identity.agents
  ) ?? []) {
    const type =
      agent.kind === 'person'
        ? 'Person'
        : agent.kind === 'organization'
          ? 'Group'
          : 'InformationObject';
    const entity = projection.add(
      labelEntity(urn(agent.id), type, agent.name),
      pointer('identity', 'agents'),
      'agent-kind'
    );
    if (agent.biography)
      entity.referred_to_by = [
        statement(derivedId(entity.id, 'biography'), agent.biography)
      ];
  }
  for (const place of answerValue<MuseumPlace[]>(
    context.modules.artwork.places
  ) ?? []) {
    const entity = projection.add(
      labelEntity(urn(place.id), 'Place', place.name),
      pointer('artwork', 'places'),
      'local-place-no-authority-equivalence'
    );
    if (place.note)
      entity.referred_to_by = [
        statement(derivedId(entity.id, 'note'), place.note, place.language)
      ];
    if (place.role === 'depicted' && work.type === 'VisualItem') {
      append(work, 'represents', ref(entity));
      projection.mark(work, pointer('artwork', 'places'), 'depicted-place');
    }
  }
  for (const component of answerValue<MuseumComponent[]>(
    context.modules.artwork.components
  ) ?? []) {
    const entity = projection.add(
      labelEntity(urn(component.id), componentType(component), component.name),
      pointer('artwork', 'components'),
      'distinct-content-or-realization'
    );
    entity.referred_to_by = [
      statement(derivedId(entity.id, 'description'), component.description)
    ];
    const actors = projection.actors(component.creators);
    if (actors.length)
      entity.created_by = {
        id: derivedId(entity.id, 'creation'),
        type: 'Creation',
        carried_out_by: actors
      };
  }
  for (const physical of answerValue<MuseumPhysicalObject[]>(
    context.modules.artwork.physical_objects
  ) ?? []) {
    const entity = projection.add(
      labelEntity(urn(physical.id), 'HumanMadeObject', physical.name),
      pointer('artwork', 'physical_objects'),
      'physical-object-not-file-or-title'
    );
    entity.referred_to_by = [
      statement(derivedId(entity.id, 'materials-account'), physical.materials)
    ];
    const actors = projection.actors(physical.creators);
    if (physical.date || actors.length)
      entity.produced_by = {
        id: derivedId(entity.id, 'production'),
        type: 'Production',
        ...(physical.date
          ? { timespan: timespan(entity.id, physical.date) }
          : {}),
        ...(actors.length ? { carried_out_by: actors } : {})
      };
  }
  for (const link of context.asset_links) {
    if (projection.get(link.asset_id)) continue;
    const entity = projection.add(
      labelEntity(
        urn(link.asset_id),
        'DigitalObject',
        String(link.manifest.filename ?? link.label ?? 'File')
      ),
      '/asset_links',
      'received-digital-object'
    );
    if (typeof link.manifest.detected_mime === 'string')
      entity.format = link.manifest.detected_mime;
    for (const [property, kind, unit] of [
      ['width', 'width', 'px'],
      ['height', 'height', 'px'],
      ['size_bytes', 'file_size', 'byte']
    ]) {
      const value = link.manifest[property];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
        continue;
      append(entity, 'dimension', {
        id: derivedId(entity.id, `measurement:${property}`),
        type: 'Dimension',
        value,
        classified_as: [
          {
            id: `urn:stream:museum:measurement:${kind}:digital_file`,
            type: 'Type',
            _label: `digital file ${kind}`
          }
        ],
        unit: {
          id: `urn:stream:museum:unit:${unit}`,
          type: 'MeasurementUnit',
          _label: unit
        }
      });
    }
  }
  for (const classification of answerValue<Record<string, Json>[]>(
    context.modules.artwork.classifications
  ) ?? []) {
    const type = classification.role === 'material' ? 'Material' : 'Type';
    const term = projection.add(
      labelEntity(
        urn(String(classification.id)),
        type,
        String(classification.label)
      ),
      pointer('artwork', 'classifications'),
      'artist-declared-local-classification'
    );
    const subject = projection.get(String(classification.subject_id));
    if (
      subject &&
      ['work_type', 'medium', 'genre'].includes(String(classification.role))
    )
      append(subject, 'classified_as', ref(term));
    if (subject?.type === 'HumanMadeObject' && type === 'Material')
      append(subject, 'made_of', ref(term));
  }
  return work;
}

function authorityTarget(
  details: Record<string, Json>,
  entity: Entity
): string | null {
  const authority = String(details.authority);
  const identifier = String(details.identifier);
  const canonical = String(details.canonical_iri);
  const canonicalByAuthority: Record<string, string> = {
    GETTY_TGN: `http://vocab.getty.edu/tgn/${identifier}`,
    GETTY_AAT: `http://vocab.getty.edu/aat/${identifier}`,
    GETTY_ULAN: `http://vocab.getty.edu/ulan/${identifier}`,
    VIAF: `http://viaf.org/viaf/${identifier}`,
    WIKIDATA: `http://www.wikidata.org/entity/${identifier}`
  };
  if (canonicalByAuthority[authority] !== canonical) return null;
  if (
    authority === 'WIKIDATA'
      ? !/^Q[1-9][0-9]*$/.test(identifier)
      : !/^[0-9]+$/.test(identifier)
  )
    return null;
  const allowed: Record<string, string[]> = {
    GETTY_TGN: ['Place'],
    GETTY_AAT: ['Type', 'Material'],
    GETTY_ULAN: ['Person', 'Group'],
    VIAF: ['Person', 'Group'],
    WIKIDATA: [
      'Place',
      'Person',
      'Group',
      'HumanMadeObject',
      'VisualItem',
      'LinguisticObject',
      'InformationObject',
      'Type',
      'Material'
    ]
  };
  if (!allowed[authority]?.includes(entity.type)) return null;
  // Linked Art's la:equivalent convention uses the canonical TGN/ULAN record.
  // The distinct real-world focus remains explicit in the source assertion.
  if (
    details.focus_iri &&
    !(authority === 'GETTY_TGN' && details.focus_iri === `${canonical}-place`)
  )
    return null;
  return canonical;
}

function projectMuseumJournal(projection: Projection): string[] {
  const records = projection.museumRecords;
  const superseded = new Set(
    records.map((record) => record.supersedes_id).filter(Boolean)
  );
  const candidates: {
    entity: Entity;
    target: string;
    authority: string;
    assignment: Entity;
    source: string;
  }[] = [];
  records.forEach((record, index) => {
    const source = `/museum_records/${index}`;
    const payload = record.payload_json as Record<string, Json>;
    if (
      !payload ||
      record.context_id !== projection.context.id ||
      typeof record.actor_profile_id !== 'string' ||
      !record.actor_profile_id
    )
      return;
    const actorId = derivedId(
      'museum-journal-recorder',
      record.actor_profile_id
    );
    const actor = projection.add(
      labelEntity(
        actorId,
        'Actor',
        `Recorder using 6529 profile ${record.actor_profile_id}`
      ),
      source,
      'institutional-recorder-identity-without-person-or-group-inference'
    );
    const note = projection.add(
      statement(
        urn(String(record.id)),
        String(payload.statement ?? payload.title ?? record.kind)
      ),
      source,
      'independent-institutional-statement'
    );
    note.referred_to_by = [
      statement(
        derivedId(note.id, 'source-context'),
        JSON.stringify({
          kind: record.kind,
          status: payload.event_status,
          superseded: superseded.has(record.id),
          details: payload.details
        })
      )
    ];
    const recorded =
      typeof record.created_at === 'number' &&
      Number.isFinite(record.created_at)
        ? new Date(record.created_at).toISOString()
        : null;
    note.created_by = {
      id: derivedId(note.id, 'recording'),
      type: 'Creation',
      carried_out_by: [ref(actor)],
      ...(recorded
        ? {
            timespan: {
              id: derivedId(note.id, 'recording-time'),
              type: 'TimeSpan',
              begin_of_the_begin: recorded,
              end_of_the_end: recorded
            }
          }
        : {})
    };
    for (const subjectId of (payload.subject_ids as string[] | undefined) ??
      []) {
      const subject = projection.get(subjectId);
      if (subject) {
        append(subject, 'referred_to_by', ref(note));
        projection.mark(
          subject,
          source,
          'attributed-institutional-account-not-an-executed-transfer'
        );
      }
    }
    if (record.kind !== 'authority_alignment') return;
    const details = payload.details as Record<string, Json>;
    const subject = projection.get(String(details.entity_id));
    const evidence = projection.get(String(details.snapshot_asset_id));
    const evidenceLink = projection.context.asset_links.find(
      (link) => link.asset_id === details.snapshot_asset_id
    );
    if (
      !subject ||
      evidence?.type !== 'DigitalObject' ||
      !/^[a-f0-9]{64}$/i.test(String(evidenceLink?.manifest.sha256 ?? '')) ||
      !recorded ||
      !(payload.subject_ids as string[] | undefined)?.includes(
        String(details.entity_id)
      )
    )
      return;
    const target = authorityTarget(details, subject);
    if (
      !target ||
      details.review_status !== 'reviewed' ||
      details.match_kind !== 'equivalent_entity' ||
      payload.event_status !== 'completed' ||
      superseded.has(record.id)
    )
      return;
    const assignment = projection.add(
      {
        id: derivedId(note.id, 'identity-assignment'),
        type: 'AttributeAssignment',
        assigned_to: ref(subject),
        assigned_property: 'equivalent',
        assigned: [
          {
            id: target,
            type: subject.type,
            _label: String(details.observed_label)
          }
        ],
        carried_out_by: [ref(actor)],
        used_specific_object: [ref(evidence)],
        referred_to_by: [ref(note)],
        timespan: {
          id: derivedId(note.id, 'assignment-time'),
          type: 'TimeSpan',
          begin_of_the_begin: recorded,
          end_of_the_end: recorded
        }
      },
      source,
      'reviewed-authority-identity-with-recorder-and-snapshot'
    );
    append(subject, 'attributed_by', ref(assignment));
    candidates.push({
      entity: subject,
      target,
      authority: String(details.authority),
      assignment,
      source
    });
  });
  const conflicts: string[] = [];
  for (const candidate of candidates) {
    const targets = new Set(
      candidates
        .filter(
          (other) =>
            other.entity.id === candidate.entity.id &&
            other.authority === candidate.authority
        )
        .map((other) => other.target)
    );
    if (targets.size > 1) {
      conflicts.push(candidate.source);
      continue;
    }
    if (
      !((candidate.entity.equivalent as Entity[] | undefined) ?? []).some(
        (other) => other.id === candidate.target
      )
    )
      append(
        candidate.entity,
        'equivalent',
        (candidate.assignment.assigned as Entity[])[0]
      );
    projection.mark(
      candidate.entity,
      candidate.source,
      'unambiguous-reviewed-authority-equivalence'
    );
  }
  return conflicts;
}

function linkCarriers(projection: Projection, work: Entity): void {
  const canonical = answerValue<string>(
    projection.context.modules.artwork.canonical_asset_id
  );
  const file = canonical ? projection.get(canonical) : undefined;
  if (file) {
    if (work.type === 'VisualItem') file.digitally_shows = [ref(work)];
    if (work.type === 'LinguisticObject') file.digitally_carries = [ref(work)];
    projection.mark(
      file,
      pointer('artwork', 'canonical_asset_id'),
      'canonical-content-carrier'
    );
  }
  for (const component of answerValue<MuseumComponent[]>(
    projection.context.modules.artwork.components
  ) ?? []) {
    const content = projection.get(component.id)!;
    for (const assetId of component.asset_ids ?? []) {
      const carrier = projection.get(assetId);
      if (!carrier || carrier.type !== 'DigitalObject') continue;
      if (content.type === 'VisualItem')
        append(carrier, 'digitally_shows', ref(content));
      if (content.type === 'LinguisticObject')
        append(carrier, 'digitally_carries', ref(content));
      projection.mark(
        carrier,
        pointer('artwork', 'components'),
        'explicit-content-carrier'
      );
    }
  }
}

function projectDocuments(projection: Projection, work: Entity): void {
  for (const document of answerValue<MuseumDocument[]>(
    projection.context.modules.context.documents
  ) ?? []) {
    if (
      ['machine_transcript', 'machine_translation'].includes(
        document.authorship
      ) &&
      document.review_status !== 'author_reviewed'
    )
      continue;
    const entity = projection.add(
      labelEntity(urn(document.id), 'LinguisticObject', document.title),
      pointer('context', 'documents'),
      'attributed-linguistic-document'
    );
    if (document.text) entity.content = document.text;
    entity.language = [
      {
        id: `urn:ietf:bcp:47:${document.language}`,
        type: 'Language',
        _label: document.language
      }
    ];
    const actors = projection.actors(document.authors);
    if (actors.length)
      entity.created_by = {
        id: derivedId(entity.id, 'creation'),
        type: 'Creation',
        carried_out_by: actors
      };
    if (!['research', 'reference', 'other'].includes(document.kind)) {
      append(work, 'referred_to_by', ref(entity));
      projection.mark(
        work,
        pointer('context', 'documents'),
        'work-document-reference'
      );
    }
    const file = document.asset_id
      ? projection.get(document.asset_id)
      : undefined;
    if (file) {
      append(file, 'digitally_carries', ref(entity));
      projection.mark(
        file,
        pointer('context', 'documents'),
        'document-carrier'
      );
    }
  }
  for (const field of ['caption', 'artist_statement']) {
    const localized = answerValue<{
      versions: { language: string; text: string }[];
    }>(projection.context.modules.context[field]);
    for (const version of localized?.versions ?? []) {
      const entity = projection.add(
        statement(
          derivedId(work.id, `${field}:${version.language}`),
          version.text,
          version.language
        ),
        pointer('context', field),
        'artist-account-language-version'
      );
      append(work, 'referred_to_by', ref(entity));
      projection.mark(
        work,
        pointer('context', field),
        'work-artist-account-reference'
      );
    }
  }
}

function projectEvents(projection: Projection): void {
  for (const event of answerValue<MuseumEvent[]>(
    projection.context.modules.context.events
  ) ?? []) {
    const subjects = event.subject_ids
      .map((id) => projection.get(id))
      .filter((item): item is Entity => !!item);
    const type =
      event.kind === 'production' &&
      subjects.every((subject) => subject.type === 'HumanMadeObject')
        ? 'Production'
        : ['capture', 'creation'].includes(event.kind) &&
            subjects.every((subject) =>
              [
                'VisualItem',
                'LinguisticObject',
                'InformationObject',
                'DigitalObject'
              ].includes(subject.type)
            )
          ? 'Creation'
          : 'Activity';
    const entity = projection.add(
      labelEntity(urn(event.id), type, event.title),
      pointer('context', 'events'),
      'artist-evidenced-event'
    );
    entity.referred_to_by = [
      statement(derivedId(entity.id, 'account'), event.account)
    ];
    if (event.date) entity.timespan = timespan(entity.id, event.date);
    const actors = projection.actors(event.participants);
    if (actors.length) entity.carried_out_by = actors;
    const place = event.place_id ? projection.get(event.place_id) : undefined;
    if (place?.type === 'Place') entity.took_place_at = [ref(place)];
    for (const subject of subjects) {
      if (type === 'Production')
        projection.activity(subject, 'produced_by', entity);
      if (type === 'Creation')
        projection.activity(subject, 'created_by', entity);
      projection.mark(
        subject,
        pointer('context', 'events'),
        'subject-event-domain'
      );
    }
    // Other subject, input and output relationships retain their exact meanings in the sidecar.
  }
  for (const session of answerValue<MuseumInterviewSession[]>(
    projection.context.modules.interview.sessions
  ) ?? []) {
    const entity = projection.add(
      labelEntity(urn(session.id), 'Activity', session.title),
      pointer('interview', 'sessions'),
      'interview-activity'
    );
    entity.timespan = timespan(entity.id, session.date);
    const actors = projection.actors(session.participants);
    if (actors.length) entity.carried_out_by = actors;
    if (session.transcript_text) {
      const transcript = projection.add(
        statement(
          derivedId(entity.id, 'transcript'),
          session.transcript_text,
          session.language
        ),
        pointer('interview', 'sessions'),
        'interview-transcript'
      );
      transcript.about = [ref(entity)];
      entity.referred_to_by = [ref(transcript)];
      const file = session.transcript_asset_id
        ? projection.get(session.transcript_asset_id)
        : undefined;
      if (file) {
        append(file, 'digitally_carries', ref(transcript));
        projection.mark(
          file,
          pointer('interview', 'sessions'),
          'transcript-carrier'
        );
      }
    }
  }
}

function projectMeasurements(projection: Projection): void {
  for (const measurement of answerValue<MuseumMeasurement[]>(
    projection.context.modules.artwork.measurements
  ) ?? []) {
    const subject = projection.get(measurement.subject_id);
    if (!subject) continue;
    const dimension: Entity = {
      id: urn(measurement.id),
      type: 'Dimension',
      value: measurement.value,
      _label: `${measurement.scope} ${measurement.kind}: ${measurement.value} ${measurement.unit}`,
      classified_as: [
        {
          id: `urn:stream:museum:measurement:${measurement.kind}:${measurement.scope}`,
          type: 'Type',
          _label: `${measurement.scope} ${measurement.kind}`
        }
      ],
      unit: {
        id: `urn:stream:museum:unit:${measurement.unit === 'other' ? measurement.id : measurement.unit}`,
        type: 'MeasurementUnit',
        _label: measurement.unit_label ?? measurement.unit
      }
    };
    if (measurement.precision || measurement.note)
      dimension.referred_to_by = [
        statement(
          derivedId(dimension.id, 'measurement-note'),
          [measurement.precision, measurement.note].filter(Boolean).join('\n')
        )
      ];
    append(subject, 'dimension', dimension);
    projection.mark(
      subject,
      pointer('artwork', 'measurements'),
      'scoped-original-measurement-no-conversion'
    );
  }
}

function projectRelationships(projection: Projection): void {
  for (const relation of answerValue<MuseumRelationship[]>(
    projection.context.modules.artwork.relationships
  ) ?? []) {
    const subject = projection.get(relation.subject_id);
    const object = projection.get(relation.object_id);
    if (!subject || !object) continue;
    if (relation.relation === 'depicts' && subject.type === 'VisualItem')
      append(subject, 'represents', ref(object));
    else if (
      relation.relation === 'documents' &&
      subject.type === 'LinguisticObject'
    )
      append(subject, 'about', ref(object));
    else if (
      relation.relation === 'component_of' &&
      subject.type === object.type &&
      ['HumanMadeObject', 'VisualItem', 'LinguisticObject'].includes(
        subject.type
      )
    )
      append(subject, 'part_of', ref(object));
    else continue;
    projection.mark(
      subject,
      pointer('artwork', 'relationships'),
      'domain-checked-explicit-relationship'
    );
  }
}

function claims(
  projection: Projection
): { entity_id: string; property_path: string; sources: ClaimSource[] }[] {
  const result: {
    entity_id: string;
    property_path: string;
    sources: ClaimSource[];
  }[] = [];
  function walk(
    value: Json,
    entityId: string,
    path: string,
    sources: ClaimSource[]
  ): void {
    if (Array.isArray(value)) {
      value.forEach((item, index) =>
        walk(item, entityId, `${path}/${index}`, sources)
      );
      return;
    }
    if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value))
        walk(item, entityId, `${path}/${key}`, sources);
      return;
    }
    result.push({ entity_id: entityId, property_path: path, sources });
  }
  for (const entity of Array.from(projection.entities.values()))
    walk(entity, entity.id, '', projection.sources.get(entity.id) ?? []);
  return result.sort((a, b) =>
    `${a.entity_id}${a.property_path}`.localeCompare(
      `${b.entity_id}${b.property_path}`
    )
  );
}

export function buildLinkedArtExport(
  context: ContextRecord,
  museumRecords: Record<string, unknown>[] = []
) {
  const normalizedRecords = museumRecords.map(
    (record) =>
      normalizeJson({
        ...record,
        payload_json: parseJson(record.payload_json)
      }) as Record<string, Json>
  );
  const projection = new Projection(context, normalizedRecords);
  const work = seedEntities(projection);
  linkCarriers(projection, work);
  projectDocuments(projection, work);
  projectEvents(projection);
  projectMeasurements(projection);
  projectRelationships(projection);
  const authorityConflicts = projectMuseumJournal(projection);
  const entities = Array.from(projection.entities.values()).sort((a, b) =>
    a.id.localeCompare(b.id)
  );
  const coverage: Coverage[] = [];
  for (const [moduleId, answers] of Object.entries(context.modules))
    for (const [field, answer] of Object.entries(answers)) {
      const sourcePointer =
        answer.status === 'provided'
          ? pointer(moduleId, field)
          : `/modules/${moduleId}/${field}`;
      const rule = projection.mapped.get(sourcePointer);
      coverage.push({
        source_pointer: sourcePointer,
        disposition: rule
          ? 'projected_with_source_retained'
          : 'retained_stream_only',
        rule: rule ?? 'source-account-retained-without-lossy-standard-property'
      });
    }
  coverage.push({
    source_pointer: '/asset_links',
    disposition: 'projected_with_source_retained',
    rule: 'digital-object-with-full-byte-evidence-retained'
  });
  normalizedRecords.forEach((record, index) =>
    coverage.push({
      source_pointer: `/museum_records/${index}`,
      disposition: projection.mapped.has(`/museum_records/${index}`)
        ? 'projected_with_source_retained'
        : 'retained_stream_only',
      rule:
        projection.mapped.get(`/museum_records/${index}`) ??
        'institutional-source-preserved'
    })
  );
  coverage.sort((a, b) => a.source_pointer.localeCompare(b.source_pointer));
  const sourceSnapshot = normalizeJson({
    work_id: context.work_id,
    context_id: context.id,
    owner_profile_id: context.owner_profile_id,
    program_id: context.program_id,
    profile: context.profile,
    modules: context.modules,
    asset_links: context.asset_links,
    museum_records: normalizedRecords
  });
  const issues = [
    ...museumRecordIssues(context),
    ...context.profile.required_for_review
      .filter((path) => {
        const [moduleId, field] = path.split('.');
        return !context.modules[moduleId as ModuleId]?.[field];
      })
      .map((field) => ({ field, code: 'ANSWER_REQUIRED', lane: 'curatorial' }))
  ];
  const output = {
    profile_lock: LINKED_ART_PROFILE_LOCK,
    pinned_context: pinnedContext,
    source_snapshot: sourceSnapshot,
    source_snapshot_sha256: digest(sourceSnapshot),
    work: ref(work),
    resources: entities
      .filter((entity) => !['InformationObject', 'Actor'].includes(entity.type))
      .map((entity): Entity => ({ '@context': CONTEXT, ...entity })),
    crm_extensions: entities
      .filter((entity) => ['InformationObject', 'Actor'].includes(entity.type))
      .map((entity): Entity => ({ '@context': CONTEXT, ...entity })),
    provenance_index: claims(projection),
    coverage,
    authority_conflicts: authorityConflicts,
    ambiguous_activity_subjects: Array.from(
      projection.ambiguousActivities
    ).sort((a, b) => a.localeCompare(b)),
    status: issues.length ? 'incomplete' : 'complete_with_stream_extensions',
    validation: {
      profile_subset: 'stream-museum-linked-art-draft-1',
      complete_stream_schema_conformance: false,
      http_api_conformance: false,
      issues
    }
  };
  validateLinkedArtProjection(output.resources, output.crm_extensions);
  return output;
}

/** Validate emitted relationships against the actual class of every local entity. */
export function validateLinkedArtProjection(
  resources: Entity[],
  extensions: Entity[]
): void {
  const all = [...resources, ...extensions];
  const entities = new Map(all.map((entity) => [entity.id, entity]));
  if (entities.size !== all.length)
    throw new Error('Duplicate Linked Art entity');
  const ensure = (condition: boolean, message: string) => {
    if (!condition) throw new Error(message);
  };
  const properties = new Set([
    '@context',
    'id',
    'type',
    '_label',
    'identified_by',
    'content',
    'language',
    'created_by',
    'produced_by',
    'referred_to_by',
    'represents',
    'format',
    'dimension',
    'classified_as',
    'value',
    'unit',
    'timespan',
    'begin_of_the_begin',
    'end_of_the_end',
    'carried_out_by',
    'took_place_at',
    'digitally_shows',
    'digitally_carries',
    'about',
    'part_of',
    'made_of',
    'equivalent',
    'attributed_by',
    'assigned_to',
    'assigned_property',
    'assigned',
    'used_specific_object'
  ]);
  function walk(value: Json): void {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const node = value as Entity;
    ensure(
      Object.keys(node).every((key) => properties.has(key)),
      'Unsupported Linked Art property'
    );
    if (node['@context'])
      ensure(node['@context'] === CONTEXT, 'Unpinned Linked Art context');
    if (node.type)
      ensure(
        Object.prototype.hasOwnProperty.call(TYPES, node.type),
        `Unsupported Linked Art class ${node.type}`
      );
    if (node.type === 'AttributeAssignment' && node.assigned) {
      const subject = node.assigned_to as Entity | undefined;
      ensure(
        !!subject && entities.has(subject.id),
        'Unresolved assignment subject'
      );
      ensure(
        node.assigned_property === 'equivalent' &&
          (node.assigned as Entity[]).every(
            (target) => target.type === subject!.type
          ),
        'Incompatible authority assignment target'
      );
    }
    if (node.id && entities.has(node.id))
      ensure(
        entities.get(node.id)!.type === node.type,
        'Linked Art reference type mismatch'
      );
    if (node.id?.startsWith('urn:uuid:') && !entities.has(node.id)) {
      ensure(
        Object.keys(node).some(
          (key) => !['id', 'type', '_label'].includes(key)
        ),
        'Unresolved Linked Art entity reference'
      );
    }
    for (const [property, item] of Object.entries(node)) {
      if (
        [
          'digitally_shows',
          'digitally_carries',
          'created_by',
          'produced_by',
          'carried_out_by',
          'took_place_at'
        ].includes(property)
      ) {
        const targets = (Array.isArray(item) ? item : [item]) as Entity[];
        const rule: Record<string, { subjects: string[]; targets: string[] }> =
          {
            digitally_shows: {
              subjects: ['DigitalObject'],
              targets: ['VisualItem']
            },
            digitally_carries: {
              subjects: ['DigitalObject'],
              targets: ['LinguisticObject']
            },
            created_by: {
              subjects: [
                'VisualItem',
                'LinguisticObject',
                'DigitalObject',
                'InformationObject'
              ],
              targets: ['Creation']
            },
            produced_by: {
              subjects: ['HumanMadeObject'],
              targets: ['Production']
            },
            carried_out_by: {
              subjects: [
                'Activity',
                'Creation',
                'Production',
                'AttributeAssignment'
              ],
              targets: ['Person', 'Group', 'Actor']
            },
            took_place_at: {
              subjects: ['Activity', 'Creation', 'Production'],
              targets: ['Place']
            }
          };
        ensure(
          rule[property].subjects.includes(node.type),
          `Invalid ${property} subject`
        );
        targets.forEach((target) =>
          ensure(
            rule[property].targets.includes(target.type),
            `Invalid ${property} target`
          )
        );
      }
      if (property === 'equivalent')
        ensure(
          (item as Entity[]).every((target) => target.type === node.type),
          'Incompatible authority equivalent entity kind'
        );
      if (property === 'made_of')
        ensure(
          node.type === 'HumanMadeObject' &&
            (item as Entity[]).every((target) => target.type === 'Material'),
          'Invalid material relationship'
        );
      if (property === 'assigned_property')
        ensure(
          node.type === 'AttributeAssignment' && item === 'equivalent',
          'Unsupported attribute assignment'
        );
      if (property === 'attributed_by')
        ensure(
          (item as Entity[]).every(
            (target) => target.type === 'AttributeAssignment'
          ),
          'Invalid attribution target'
        );
      if (property !== '@context') walk(item);
    }
  }
  all.forEach(walk);
}
