import { parseJson } from '../../artwork-documentation.db';
import {
  answerValue,
  matchesSchema
} from '../../artwork-documentation.validation';
import {
  AssetTechnicalMetadata,
  StoredAsset
} from '../../assets/artwork-assets.types';
import { museumRecordDefinition } from '../../institution/museum-record.catalogue';
import { DossierIssue, DossierSnapshot } from './dossier.types';
import { element as e } from './xml';

type Value = Record<string, unknown>;
const objectValue = (value: unknown): Value | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Value)
    : null;
const rows = (value: unknown): Value[] =>
  Array.isArray(value) ? (value as Value[]) : [];
const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
const uri = (id: string) => `urn:uuid:${id}`;
const local = (id: string, purpose: string) =>
  `urn:6529:premis:${id}:${purpose}`;
const profileUri = (id: unknown) =>
  `urn:6529:profile:${encodeURIComponent(String(id))}`;
const identifier = (kind: string, id: string, role?: string) =>
  `<premis:${kind}Identifier>${e(`premis:${kind}IdentifierType`, 'URI')}${e(`premis:${kind}IdentifierValue`, id)}${role ? e(`premis:${kind}Role`, role) : ''}</premis:${kind}Identifier>`;
const objectLink = (id: string, role?: string) =>
  identifier('linkingObject', uri(id), role);
const agentLink = (id: string, role: string) =>
  identifier('linkingAgent', id, role);
const extension = (tag: string, value: unknown) =>
  `<premis:${tag}><stream:source>${e('stream:json', JSON.stringify(value))}</stream:source></premis:${tag}>`;
const significant = (kind: string, value: unknown) =>
  `<premis:significantProperties>${e('premis:significantPropertiesType', kind)}${e('premis:significantPropertiesValue', value)}</premis:significantProperties>`;
const technical = (asset: StoredAsset): AssetTechnicalMetadata | null =>
  asset.technical_metadata_json
    ? parseJson<AssetTechnicalMetadata>(asset.technical_metadata_json)
    : null;

function relationship(type: string, subtype: string, id: string): string {
  return `<premis:relationship>${e('premis:relationshipType', type)}${e('premis:relationshipSubType', subtype)}${identifier('relatedObject', uri(id))}</premis:relationship>`;
}
function agent(
  id: string,
  name: unknown,
  type?: string,
  version?: unknown,
  note?: unknown
): string {
  return `<premis:agent>${identifier('agent', id)}${e('premis:agentName', name)}${type ? e('premis:agentType', type) : ''}${version ? e('premis:agentVersion', version) : ''}${note ? e('premis:agentNote', note) : ''}</premis:agent>`;
}
function event(
  id: string,
  type: unknown,
  date: string,
  detail: unknown,
  outcome: unknown,
  agents: string,
  objects: string,
  source?: unknown
): string {
  return `<premis:event>${identifier('event', id)}${e('premis:eventType', type)}${e('premis:eventDateTime', date)}<premis:eventDetailInformation>${e('premis:eventDetail', detail)}${source ? extension('eventDetailExtension', source) : ''}</premis:eventDetailInformation><premis:eventOutcomeInformation>${e('premis:eventOutcome', outcome)}</premis:eventOutcomeInformation>${agents}${objects}</premis:event>`;
}

function fileObject(
  asset: StoredAsset,
  snapshot: DossierSnapshot,
  objectIds: Set<string>
): string {
  const metadata = technical(asset);
  const registry = metadata?.format_registry;
  const formatRegistry =
    registry?.status === 'signature_match'
      ? `<premis:formatRegistry>${e('premis:formatRegistryName', 'PRONOM')}${e('premis:formatRegistryKey', registry.identifier)}${e('premis:formatRegistryRole', registry.identification_scope)}</premis:formatRegistry>`
      : '';
  const link = snapshot.context.asset_links.find(
    (item) => item.asset_id === asset.id
  );
  const relationships = (link?.derived_from_asset_ids ?? [])
    .filter((id) => objectIds.has(id))
    .map((id) => relationship('derivation', 'has source', id))
    .join('');
  const fixity = asset.sha256
    ? `<premis:fixity>${e('premis:messageDigestAlgorithm', 'SHA-256')}${e('premis:messageDigest', asset.sha256)}${e('premis:messageDigestOriginator', '6529 artwork original-byte inspection')}</premis:fixity>`
    : '';
  // Deployment bucket names and signed access URLs are not archival identifiers.
  return `<premis:object xsi:type="premis:file">${identifier('object', uri(asset.id))}<premis:objectCharacteristics>${fixity}${e('premis:size', asset.size_bytes)}<premis:format><premis:formatDesignation>${e('premis:formatName', asset.detected_mime ?? 'application/octet-stream')}</premis:formatDesignation>${formatRegistry}</premis:format>${metadata ? extension('objectCharacteristicsExtension', metadata) : ''}</premis:objectCharacteristics>${e('premis:originalName', asset.filename)}${relationships}</premis:object>`;
}

function technicalEvents(
  asset: StoredAsset,
  agents: Map<string, string>
): string[] {
  const metadata = technical(asset);
  const events: string[] = [];
  if (metadata?.measured_at) {
    const processor = 'urn:6529:software:artwork-characterization-v1';
    agents.set(
      processor,
      agent(
        processor,
        '6529 artwork file inspection',
        'software',
        '1',
        'The method and tool versions are recorded on each characterization event.'
      )
    );
    events.push(
      event(
        local(asset.id, 'characterization'),
        'format identification',
        metadata.measured_at,
        metadata.method,
        metadata.characterization,
        agentLink(processor, 'executing program'),
        objectLink(asset.id, 'object inspected'),
        metadata
      )
    );
    // A digest measurement is not a comparison against an earlier reference digest.
    events.push(
      event(
        local(asset.id, 'digest'),
        'message digest calculation',
        metadata.measured_at,
        `SHA-256 of the exact uploaded original: ${metadata.original_sha256}`,
        'calculated',
        agentLink(processor, 'executing program'),
        objectLink(asset.id, 'object measured')
      )
    );
    const c2pa = metadata.c2pa;
    if (c2pa && !['not_validated', 'unsupported'].includes(c2pa.status)) {
      const validator = `urn:6529:software:c2pa:${encodeURIComponent(c2pa.validator ?? 'unspecified')}:${encodeURIComponent(c2pa.validator_version ?? 'unspecified')}`;
      agents.set(
        validator,
        agent(
          validator,
          c2pa.validator ?? 'C2PA validator',
          'software',
          c2pa.validator_version,
          'Manifest integrity is separate from signer trust and artwork authorship.'
        )
      );
      events.push(
        event(
          local(asset.id, 'c2pa'),
          'validation',
          'unknown',
          'C2PA validation of original bytes; signer trust not assessed; remote manifest fetching disabled. No separate validation timestamp is stored.',
          c2pa.integrity ?? c2pa.status,
          agentLink(validator, 'executing program'),
          objectLink(asset.id, 'object validated'),
          c2pa
        )
      );
    }
  }
  if (asset.scan_status) {
    const scanner = 'urn:6529:software:website-file-safety-pipeline';
    agents.set(
      scanner,
      agent(
        scanner,
        '6529 website file safety pipeline',
        'software',
        undefined,
        'Scanner version and event time are not available in this stored asset record.'
      )
    );
    events.push(
      event(
        local(asset.id, 'malware-scan'),
        'virus check',
        'unknown',
        'Stored safety-scan result for the original uploaded file; this is not a format or rights assessment.',
        asset.scan_status,
        agentLink(scanner, 'executing program'),
        objectLink(asset.id, 'object checked')
      )
    );
  }
  return events;
}

function journalEvent(
  record: Value,
  payload: Value,
  details: Value,
  objects: Set<string>,
  agents: Map<string, string>
): string | null {
  if (record.kind !== 'preservation' || payload.event_status !== 'completed')
    return null;
  const recorder = profileUri(record.actor_profile_id);
  agents.set(
    recorder,
    agent(
      recorder,
      record.actor_profile_id,
      undefined,
      undefined,
      'Authenticated 6529 profile that recorded this institutional statement; profile identity does not assert a legal person.'
    )
  );
  const responsible = local(String(record.id), 'responsible-agent');
  agents.set(
    responsible,
    agent(
      responsible,
      details.agent,
      undefined,
      undefined,
      'Responsible agent as named by the journal recorder; identity and agent type are not independently resolved.'
    )
  );
  const inputs = strings(details.input_asset_ids);
  const outputs = strings(details.output_asset_ids);
  const links = [
    ...inputs
      .filter((id) => objects.has(id))
      .map((id) => objectLink(id, 'source')),
    ...outputs
      .filter((id) => objects.has(id))
      .map((id) => objectLink(id, 'outcome')),
    ...strings(payload.subject_ids)
      .filter(
        (id) => objects.has(id) && !inputs.includes(id) && !outputs.includes(id)
      )
      .map((id) => objectLink(id, 'subject'))
  ].join('');
  return event(
    uri(String(record.id)),
    details.event_type,
    typeof payload.effective_date === 'string'
      ? payload.effective_date
      : 'unknown',
    details.method,
    details.outcome,
    agentLink(responsible, 'executing agent') + agentLink(recorder, 'recorder'),
    links,
    record
  );
}

function otherRights(
  basis: unknown,
  notes: unknown[],
  instruments: string[] = []
): string {
  return `<premis:otherRightsInformation>${instruments.map((id) => identifier('otherRightsDocumentation', uri(id))).join('')}${e('premis:otherRightsBasis', basis)}${notes
    .filter((note) => note !== undefined && note !== '')
    .map((note) => e('premis:otherRightsNote', note))
    .join('')}</premis:otherRightsInformation>`;
}
function rightsStatement(
  id: string,
  basis: string,
  info: string,
  grants: string,
  subjects: string[],
  objectIds: Set<string>,
  recorder: string
): string {
  return `<premis:rightsStatement>${identifier('rightsStatement', id)}${e('premis:rightsBasis', basis)}${info}${grants}${subjects
    .filter((subject) => objectIds.has(subject))
    .map((subject) => objectLink(subject))
    .join(
      ''
    )}${agentLink(recorder, 'rights statement recorder')}</premis:rightsStatement>`;
}
function artistRights(
  snapshot: DossierSnapshot,
  objects: Set<string>,
  agents: Map<string, string>
): string[] {
  const context = snapshot.context;
  const recorder = profileUri(context.owner_profile_id);
  agents.set(
    recorder,
    agent(
      recorder,
      answerValue(context.modules.identity.display_name) ??
        context.owner_profile_id,
      undefined,
      undefined,
      `Artist record owner; confirmation state: ${snapshot.confirmation}. Rights statements are attributed source assertions, not an independent legal determination.`
    )
  );
  const statements: string[] = [];
  for (const material of rows(
    answerValue(context.modules.rights.material_rights)
  )) {
    const notes = [
      material.account,
      material.licensor ? `Licensor as stated: ${material.licensor}` : '',
      `Source assertion: ${JSON.stringify(material)}`,
      `Artist confirmation state: ${snapshot.confirmation}`
    ];
    const basis = String(material.basis);
    const license =
      basis === 'license' && material.license_uri
        ? `<premis:licenseInformation>${identifier('licenseDocumentation', String(material.license_uri))}${e('premis:licenseNote', material.account)}</premis:licenseInformation>`
        : '';
    const info =
      license +
      otherRights(
        `artist-stated ${basis}`,
        notes,
        strings(material.instrument_asset_ids)
      );
    const grants = rows(material.uses)
      .filter((use) =>
        ['granted', 'granted_with_conditions'].includes(String(use.status))
      )
      .map(
        (use) =>
          `<premis:rightsGranted>${e('premis:act', use.use)}${use.conditions ? e('premis:restriction', use.conditions) : ''}${e('premis:rightsGrantedNote', `Artist-stated ${use.status}; declaration scope and confirmation state are recorded in otherRightsInformation.`)}</premis:rightsGranted>`
      )
      .join('');
    statements.push(
      rightsStatement(
        uri(String(material.id)),
        basis === 'license' ? 'license' : 'other',
        info,
        grants,
        strings(material.subject_ids),
        objects,
        recorder
      )
    );
  }
  const terms = {
    program_id: context.program_id,
    program_rules: context.profile.program_rules ?? null,
    intended_license:
      answerValue(context.modules.rights.intended_license) ?? null,
    rights_declaration:
      answerValue(context.modules.rights.rights_declaration) ?? null,
    declaration_effect:
      answerValue(context.modules.rights.declaration_effect) ?? null,
    rights_basis: answerValue(context.modules.rights.rights_basis) ?? null,
    third_party_material:
      answerValue(context.modules.rights.third_party_material) ?? null
  };
  statements.push(
    rightsStatement(
      local(context.work_id, 'artwork-rights-account'),
      'other',
      otherRights('Artwork rights account and program requirements', [
        'These are recorded intentions and requirements. This archival projection does not execute a licence or infer permissions for separate files or contributions.',
        JSON.stringify(terms)
      ]),
      '',
      [context.work_id],
      objects,
      recorder
    )
  );
  for (const link of context.asset_links) {
    if (!link.intended_terms || link.intended_terms.kind === 'unspecified')
      continue;
    statements.push(
      rightsStatement(
        local(link.id, 'file-terms'),
        'other',
        otherRights('Intended file-specific publication terms', [
          JSON.stringify(link.intended_terms),
          'Intended terms supplied in the artist record; no automatic permission grant is inferred.'
        ]),
        '',
        [link.asset_id],
        objects,
        recorder
      )
    );
  }
  return statements;
}

/** PREMIS 3.0 objects, events, agents and scoped rights; source assertions remain attributable. */
export function buildPremis(
  snapshot: DossierSnapshot,
  issues: DossierIssue[] = []
): string {
  const context = snapshot.context;
  const components = rows(answerValue(context.modules.artwork.components));
  const documents = rows(answerValue(context.modules.context.documents));
  const objectIds = new Set([
    context.work_id,
    ...snapshot.assets.map((asset) => asset.id),
    ...components.map((item) => String(item.id)),
    ...documents.map((item) => String(item.id))
  ]);
  const agents = new Map<string, string>();
  const intent = answerValue<Value>(context.modules.preservation.intent);
  const properties = intent
    ? [
        significant('Artist preservation account', intent.account),
        significant('Artist change policy', intent.change_policy),
        ...rows(intent.significant_properties).map((property) =>
          significant(String(property.property), JSON.stringify(property))
        )
      ].join('')
    : '';
  const environment = intent?.environment
    ? `<premis:environmentDesignation>${e('premis:environmentName', intent.environment)}</premis:environmentDesignation>`
    : '';
  const objects = [
    `<premis:object xsi:type="premis:intellectualEntity">${identifier('object', uri(context.work_id))}${properties}${e('premis:originalName', answerValue(context.modules.artwork.title) ?? context.work_id)}${environment}</premis:object>`,
    ...components.map(
      (item) =>
        `<premis:object xsi:type="premis:intellectualEntity">${identifier('object', uri(String(item.id)))}${e('premis:originalName', item.name)}${relationship('structural', 'is part of', context.work_id)}</premis:object>`
    ),
    ...documents.map(
      (item) =>
        `<premis:object xsi:type="premis:intellectualEntity">${identifier('object', uri(String(item.id)))}${e('premis:originalName', item.title)}</premis:object>`
    ),
    ...snapshot.assets.map((asset) => fileObject(asset, snapshot, objectIds))
  ];
  const agentTypes: Record<string, string> = {
    person: 'person',
    organization: 'organization',
    software: 'software'
  };
  for (const declared of rows(answerValue(context.modules.identity.agents)))
    agents.set(
      uri(String(declared.id)),
      agent(
        uri(String(declared.id)),
        declared.name,
        agentTypes[String(declared.kind)],
        declared.version,
        'Artist-declared agent; authority suggestions are retained in the source dossier.'
      )
    );
  const events = snapshot.assets.flatMap((asset) =>
    technicalEvents(asset, agents)
  );
  const rights = artistRights(snapshot, objectIds, agents);
  const superseded = new Set(
    snapshot.museum_records
      .map((record) => record.supersedes_id)
      .filter(Boolean)
  );
  for (const record of snapshot.museum_records) {
    const payload = objectValue(parseJson<unknown>(record.payload_json)) ?? {};
    const recorder = profileUri(record.actor_profile_id);
    agents.set(
      recorder,
      agent(
        recorder,
        record.actor_profile_id,
        undefined,
        undefined,
        'Authenticated institutional journal recorder; distinct from the artist and from the activity being described.'
      )
    );
    const recordedAt =
      typeof record.created_at === 'number' &&
      Number.isFinite(record.created_at)
        ? new Date(record.created_at).toISOString()
        : 'unknown';
    events.push(
      event(
        local(String(record.id), 'journal-recording'),
        'metadata modification',
        recordedAt,
        'An attributed museum journal record was recorded. This event does not assert that a planned activity occurred.',
        'recorded',
        agentLink(recorder, 'recorder'),
        strings(payload.subject_ids)
          .filter((id) => objectIds.has(id))
          .map((id) => objectLink(id, 'described subject'))
          .join(''),
        record
      )
    );
    if (
      !['preservation', 'rights'].includes(String(record.kind)) ||
      payload.event_status !== 'completed' ||
      superseded.has(record.id)
    )
      continue;
    const details = objectValue(payload.details);
    const schema = museumRecordDefinition(String(record.kind))?.value_schema;
    if (!details || !schema || !matchesSchema(details, schema)) {
      issues.push({
        code: 'PREMIS_INSTITUTIONAL_DETAILS_UNAVAILABLE',
        path: `museum-record:${record.id}`,
        severity: 'warning',
        message:
          'The institutional record has no usable structured details. Its complete source and recording event are retained; no completed preservation activity or rights statement is inferred.'
      });
      continue;
    }
    const preservation = journalEvent(
      record,
      payload,
      details,
      objectIds,
      agents
    );
    if (preservation) events.push(preservation);
    if (record.kind === 'rights') {
      agents.set(
        recorder,
        agent(
          recorder,
          record.actor_profile_id,
          undefined,
          undefined,
          'Authenticated institutional rights record author.'
        )
      );
      rights.push(
        rightsStatement(
          uri(String(record.id)),
          'other',
          otherRights(
            `Institutional ${details.basis} assertion`,
            [
              details.scope,
              details.uses,
              `Licensor as stated: ${details.licensor}`,
              `Effective date as stated: ${details.effective_date ?? 'unknown'}`,
              JSON.stringify(record)
            ],
            typeof details.instrument_asset_id === 'string'
              ? [details.instrument_asset_id]
              : []
          ),
          '',
          strings(payload.subject_ids),
          objectIds,
          recorder
        )
      );
    }
  }
  const source = extension('rightsExtension', {
    artist_confirmation: snapshot.confirmation,
    rights: context.modules.rights,
    museum_records: snapshot.museum_records.filter(
      (record) => record.kind === 'rights'
    ),
    unmapped_physical_objects:
      answerValue(context.modules.artwork.physical_objects) ?? []
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<premis:premis xmlns:premis="http://www.loc.gov/premis/v3" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:stream="urn:6529:stream:preservation-source:1" version="3.0" xsi:schemaLocation="http://www.loc.gov/premis/v3 schemas/premis-v3-0.xsd">${objects.join('')}${events.join('')}${Array.from(agents.values()).join('')}<premis:rights>${rights.join('')}${source}</premis:rights></premis:premis>\n`;
}
