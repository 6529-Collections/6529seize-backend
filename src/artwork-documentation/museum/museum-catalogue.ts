import {
  DocumentationProfile,
  FieldDefinition,
  ModuleId,
  ValueSchema
} from '../artwork-documentation.types';
import { fail } from '../artwork-documentation.validation';
import { MUSEUM_MEDIA_FIELDS, MUSEUM_MEDIA_PROFILES } from './museum-media';
import { MEDIA_PROFILE_IDS } from './museum-record.types';
import {
  assetIds,
  attribution,
  authority,
  choice,
  date,
  integer,
  language,
  list,
  measurement,
  numeric,
  object,
  source,
  text,
  uri,
  uuid
} from './museum-schema';

const agent = object(
  {
    id: uuid,
    kind: choice('person', 'organization', 'software'),
    name: text(1000),
    biography: text(50000),
    profile_id: text(100),
    authorities: list(authority, 30),
    version: text(300),
    note: text(12000)
  },
  ['id', 'kind', 'name']
);
const component = object(
  {
    id: uuid,
    kind: choice(
      'visual_content',
      'text_content',
      'sound_content',
      'moving_image_content',
      'software',
      'realization',
      'component'
    ),
    name: text(1000),
    description: text(50000),
    asset_ids: assetIds,
    media_profiles: {
      ...list(choice(...MEDIA_PROFILE_IDS), 10),
      uniqueItems: true
    },
    creators: list(attribution, 100)
  },
  ['id', 'kind', 'name', 'description']
);
const physicalObject = object(
  {
    id: uuid,
    kind: choice(
      'print',
      'proof',
      'negative',
      'hardware',
      'carrier',
      'installation_component',
      'other'
    ),
    name: text(1000),
    materials: text(20000),
    date,
    creators: list(attribution, 100),
    source_asset_ids: assetIds,
    custody_note: text(12000),
    status: choice('described', 'received', 'not_located'),
    note: text(20000)
  },
  ['id', 'kind', 'name', 'materials', 'status']
);
const place = object(
  {
    id: uuid,
    name: text(1000),
    language,
    role: choice(
      'capture',
      'depicted',
      'creation',
      'production',
      'exhibition',
      'custody',
      'other'
    ),
    date,
    certainty: choice('known', 'approximate', 'uncertain'),
    latitude: numeric(-90, 90),
    longitude: numeric(-180, 180),
    note: text(12000),
    authorities: list(authority, 30)
  },
  ['id', 'name', 'role', 'certainty']
);
const relationship = object(
  {
    id: uuid,
    subject_id: uuid,
    object_id: uuid,
    relation: choice(
      'component_of',
      'version_of',
      'derived_from',
      'realization_of',
      'depicts',
      'documents',
      'transcript_of',
      'translation_of',
      'reference_for',
      'related_work',
      'part_of_series'
    ),
    note: text(12000),
    source_ids: list(uuid, 100)
  },
  ['id', 'subject_id', 'object_id', 'relation']
);
const document = object(
  {
    id: uuid,
    kind: choice(
      'artist_statement',
      'production_account',
      'installation',
      'care',
      'printing',
      'research',
      'transcript',
      'translation',
      'reference',
      'other'
    ),
    title: text(1000),
    language,
    text: text(500000),
    asset_id: uuid,
    authors: list(attribution, 100),
    authorship: choice(
      'original',
      'translation',
      'machine_transcript',
      'machine_translation'
    ),
    review_status: choice('draft', 'author_reviewed'),
    source_ids: list(uuid, 100)
  },
  ['id', 'kind', 'title', 'language', 'authors', 'authorship', 'review_status']
);
const event = object(
  {
    id: uuid,
    kind: choice(
      'capture',
      'creation',
      'completion',
      'production',
      'interview',
      'exhibition',
      'publication',
      'award',
      'prior_mint',
      'other'
    ),
    title: text(1000),
    date,
    subject_ids: { ...list(uuid, 500, 1), uniqueItems: true },
    participants: list(attribution, 100),
    place_id: uuid,
    input_asset_ids: assetIds,
    output_asset_ids: assetIds,
    source_ids: list(uuid, 100),
    account: text(50000)
  },
  ['id', 'kind', 'title', 'subject_ids', 'account']
);
const interview = object(
  {
    id: uuid,
    title: text(1000),
    date,
    language,
    mode: choice('written', 'audio', 'video', 'mixed'),
    participants: list(attribution, 100, 1),
    instrument: object(
      {
        id: text(300),
        title: text(1000),
        version: text(100),
        questions: list(object({ id: text(100), text: text(12000) }), 200),
        asset_id: uuid
      },
      ['id', 'title', 'version', 'questions']
    ),
    transcript_text: text(500000),
    transcript_document_id: uuid,
    transcript_asset_id: uuid,
    recording_asset_ids: assetIds,
    caption_asset_ids: assetIds,
    segments: list(
      object(
        {
          speaker_agent_id: uuid,
          start_seconds: numeric(),
          end_seconds: numeric(),
          question_id: text(100),
          text: text(50000)
        },
        ['speaker_agent_id', 'text']
      ),
      2000
    ),
    publication_permission: choice('intended_public_record'),
    note: text(20000)
  },
  [
    'id',
    'title',
    'date',
    'language',
    'mode',
    'participants',
    'instrument',
    'publication_permission'
  ]
);
const intent = object(
  {
    account: text(150000),
    significant_properties: list(
      object(
        {
          id: uuid,
          property: text(1000),
          reason: text(12000),
          acceptable_variation: text(12000),
          reference_asset_ids: assetIds
        },
        ['id', 'property', 'reason', 'acceptable_variation']
      ),
      200
    ),
    change_policy: text(50000),
    environment: text(50000),
    failure_behavior: text(20000),
    reference_asset_ids: assetIds,
    interview_session_ids: list(uuid, 100),
    authored_by: list(attribution, 100)
  },
  ['account', 'significant_properties', 'change_policy']
);
const materialRights = object(
  {
    id: uuid,
    subject_ids: { ...list(uuid, 500, 1), uniqueItems: true },
    basis: choice(
      'copyright',
      'license',
      'statute',
      'public_domain',
      'contract',
      'unspecified'
    ),
    account: text(20000),
    licensor: text(2000),
    license_uri: uri,
    instrument_asset_ids: assetIds,
    uses: list(
      object(
        {
          use: choice(
            'reproduction',
            'publication',
            'exhibition',
            'print',
            'derivative',
            'ai_training'
          ),
          status: choice(
            'granted',
            'granted_with_conditions',
            'denied',
            'unspecified'
          ),
          conditions: text(12000)
        },
        ['use', 'status']
      ),
      6
    ),
    date,
    source_ids: list(uuid, 100)
  },
  ['id', 'subject_ids', 'basis', 'account', 'uses']
);

function field(
  id: string,
  label: string,
  guidance: string,
  schema: ValueSchema,
  chapter: string
): FieldDefinition {
  return {
    id,
    label,
    guidance,
    chapter,
    value_schema: schema,
    editor: schema.type === 'string' ? 'long_text' : 'structured',
    allowed_statuses: ['provided'],
    default_visibility: 'public_record',
    locked_restricted: false
  };
}
const fields: Record<ModuleId, FieldDefinition[]> = {
  identity: [
    field(
      'agents',
      'People, organizations & tools',
      'Name each contributor once. Credit their particular role in the relevant account, event or document. An authority reference describes identity; it does not authorize a person to act.',
      list(agent),
      'artist'
    )
  ],
  artwork: [
    field(
      'external_identifiers',
      'Catalogue & external identifiers',
      'Record established identifiers and their issuing namespace. These references document identity; they do not verify an ownership or authority claim.',
      list(
        object(
          {
            id: uuid,
            namespace: text(300),
            identifier: text(2000),
            uri,
            note: text(12000),
            source_ids: list(uuid, 100)
          },
          ['id', 'namespace', 'identifier']
        )
      ),
      'work'
    ),
    field(
      'token_references',
      'Existing token references',
      'Identify an existing token and its relationship to this work. A supplied token reference does not bind this record to a contract or prove custody, title or creator authority.',
      list(
        object(
          {
            id: uuid,
            chain_namespace: choice('eip155'),
            chain_id: { ...text(78), format: 'uint256-string' },
            contract_address: { ...text(42), format: 'ethereum-address' },
            token_id: { ...text(78), format: 'uint256-string' },
            token_standard: choice('erc721', 'erc1155'),
            relationship: choice(
              'represents_work',
              'prior_mint',
              'related_token'
            ),
            source_url: uri,
            note: text(12000)
          },
          [
            'id',
            'chain_namespace',
            'chain_id',
            'contract_address',
            'token_id',
            'token_standard',
            'relationship'
          ]
        )
      ),
      'work'
    ),
    {
      ...field(
        'media_profiles',
        'The form of the work',
        'Select every form that belongs to the artwork itself. A recording of an interview does not make a photograph a video work.',
        { ...list(choice(...MEDIA_PROFILE_IDS), 10, 1), uniqueItems: true },
        'work'
      ),
      editor: 'media_profiles'
    },
    field(
      'components',
      'Content & components',
      'Describe separately identifiable content, components and realizations of the work. Link received files without confusing the file with the work it carries.',
      list(component, 500),
      'work'
    ),
    field(
      'physical_objects',
      'Physical objects',
      'Describe each print, proof, carrier or physical component individually. A description of delivery is an attributed account, not a museum custody receipt.',
      list(physicalObject, 500),
      'materials'
    ),
    field(
      'measurements',
      'Dimensions & measurements',
      'Record measurements against the relevant object. Image size and sheet size are separate measurements; include units and any uncertainty.',
      list(measurement, 2000),
      'materials'
    ),
    field(
      'places',
      'Places',
      'Use the place name you want preserved in the public record. State whether it is a place of capture, a depicted place or another location. Museum staff can reconcile authority terms separately.',
      list(place, 200),
      'work'
    ),
    field(
      'relationships',
      'Relationships',
      'Connect content, files, prints, documents and related works by their specific relationship. These connections retain distinctions that a list of filenames cannot.',
      list(relationship, 2000),
      'materials'
    ),
    field(
      'related_works',
      'Related works & series',
      'Identify earlier versions, related works and series, including those without an online page.',
      list(
        object(
          {
            id: uuid,
            title: text(1000),
            creator: text(1000),
            date,
            relation: choice('version_of', 'part_of_series', 'related_work'),
            source_url: uri,
            identifier: text(1000),
            note: text(12000)
          },
          ['id', 'title', 'relation']
        )
      ),
      'work'
    ),
    field(
      'inscriptions',
      'Inscriptions & marks',
      'Record text, signatures or marks that form part of the work or a specific physical object.',
      list(
        object(
          {
            id: uuid,
            subject_id: uuid,
            text: text(12000),
            language,
            location: text(1000),
            note: text(6000)
          },
          ['id', 'subject_id', 'text']
        )
      ),
      'work'
    ),
    field(
      'classifications',
      'Medium, technique & subject',
      'Retain your own wording for the work’s medium and technique. Authority references are attributed proposals until reconciled by the museum.',
      list(
        object(
          {
            id: uuid,
            subject_id: uuid,
            role: choice(
              'work_type',
              'medium',
              'material',
              'technique',
              'genre',
              'subject'
            ),
            label: text(2000),
            language,
            authorities: list(authority, 30),
            note: text(12000)
          },
          ['id', 'subject_id', 'role', 'label']
        )
      ),
      'work'
    ),
    field(
      'extent',
      'Scale & duration',
      'Describe whether the work has fixed dimensions or duration, is variable, or is dimensionless. Measurements can be recorded separately for each component.',
      object({
        kind: choice(
          'dimensions',
          'duration',
          'dimensions_and_duration',
          'variable',
          'dimensionless'
        ),
        account: text(12000)
      }),
      'work'
    )
  ],
  files: [
    field(
      'described_materials',
      'Materials described but not deposited',
      'Keep a record of known material that has not been received. Name it accurately; this description does not create an upload or a preservation receipt.',
      list(
        object(
          {
            id: uuid,
            name: text(1000),
            kind: text(300),
            description: text(20000),
            availability: choice(
              'expected',
              'retained_by_artist',
              'unavailable',
              'not_located'
            ),
            related_subject_ids: list(uuid, 100)
          },
          ['id', 'name', 'kind', 'description', 'availability']
        ),
        1000
      ),
      'materials'
    )
  ],
  context: [
    field(
      'documents',
      'Full accounts & documents',
      'Preserve the complete account, with its paragraphs and headings. Identify authors and language; distinguish a reviewed text from a machine transcript or translation.',
      list(document, 500),
      'account'
    ),
    field(
      'sources',
      'Sources & references',
      'Cite books, notebooks, conversations and online resources. A source can be useful without a URL or an uploaded file.',
      list(source, 1000),
      'account'
    ),
    field(
      'events',
      'The history of the work',
      'Record events you know about, with their dates, people, places and evidence. Institutional accessions, legal title and custody are recorded separately by the responsible museum actor.',
      list(event, 1000),
      'history'
    )
  ],
  process: MUSEUM_MEDIA_FIELDS,
  rights: [
    field(
      'material_rights',
      'Terms for supporting material',
      'Describe the rights that apply to each supporting contribution. The artwork release terms are fixed by the program when applicable; publication intent is not a claim of legal ownership.',
      list(materialRights, 1000),
      'credits'
    )
  ],
  preservation: [
    field(
      'presentation_scenes',
      'Presentation sequence',
      'Arrange the work in the order and space in which it should be encountered. Add timing, placement and accompanying text where they matter; leave technical values unset when they are not known.',
      list(
        object(
          {
            id: uuid,
            title: text(1000),
            width: integer(1),
            height: integer(1),
            duration_seconds: numeric(0),
            resources: list(
              object(
                {
                  asset_id: uuid,
                  role: choice('painting', 'supplementary'),
                  start_seconds: numeric(0),
                  end_seconds: numeric(0),
                  x: numeric(0),
                  y: numeric(0),
                  width: numeric(0),
                  height: numeric(0),
                  source_start_seconds: numeric(0),
                  source_end_seconds: numeric(0),
                  time_mode: choice('trim', 'loop', 'scale')
                },
                ['asset_id', 'role']
              ),
              500
            ),
            annotations: list(
              object(
                {
                  id: uuid,
                  kind: choice('caption', 'transcript', 'description'),
                  language,
                  text: text(500000),
                  asset_id: uuid,
                  start_seconds: numeric(0),
                  end_seconds: numeric(0)
                },
                ['id', 'kind', 'language']
              ),
              500
            )
          },
          ['id', 'title', 'resources']
        ),
        500
      ),
      'care'
    ),
    field(
      'intent',
      'The work over time',
      'Describe the appearance, behavior and relationships that carry the work’s meaning. State what may change and why, with reference material where useful.',
      intent,
      'care'
    ),
    field(
      'accessibility',
      'Access to the work',
      'Describe captions, transcripts, alternative descriptions, controls and other provisions for encountering the work. Identify limits that are inherent to its form.',
      object(
        {
          account: text(50000),
          alternative_description: text(20000),
          caption_asset_ids: assetIds,
          transcript_asset_ids: assetIds,
          interaction_alternatives: text(20000)
        },
        ['account']
      ),
      'care'
    )
  ],
  interview: [
    field(
      'sessions',
      'Conversations about the work',
      'Preserve each complete conversation with its participants, questions, language and date. A written interview can stand on its own; name recordings only when they exist.',
      list(interview, 100),
      'conversation'
    )
  ]
};
const chapter: Record<ModuleId, string> = {
  identity: 'artist',
  artwork: 'work',
  files: 'materials',
  context: 'account',
  process: 'making',
  rights: 'credits',
  preservation: 'care',
  interview: 'conversation'
};
const FIELD_LABELS: Record<string, string> = {
  'artwork.canonical_asset_id': 'Final artwork file',
  'artwork.declared_dimensions': 'Artist-declared pixel dimensions',
  'files.master_availability': 'Preservation master',
  'files.source_availability': 'Source and working files'
};
const PROPERTY_LABELS: Record<string, string> = {
  asset_id: 'File',
  asset_ids: 'Files',
  canonical_asset_id: 'Final artwork file',
  source_asset_ids: 'Source and working files',
  master_asset_ids: 'Preservation masters',
  recording_asset_ids: 'Recordings',
  transcript_asset_id: 'Transcript file',
  instrument_asset_ids: 'Supporting permissions',
  dimensions: 'Artist-declared pixel dimensions',
  declared_dimensions: 'Artist-declared pixel dimensions'
};
function annotate(schema: ValueSchema): ValueSchema {
  const result = { ...schema };
  if (result.properties)
    result.properties = Object.fromEntries(
      Object.entries(result.properties).map(([key, value]) => [
        key,
        {
          ...annotate(value),
          title:
            value.title ??
            PROPERTY_LABELS[key] ??
            key
              .split('_')
              .join(' ')
              .replace(/^./, (letter) => letter.toUpperCase())
        }
      ])
    );
  if (result.items) result.items = annotate(result.items);
  if (result.oneOf) result.oneOf = result.oneOf.map(annotate);
  return result;
}
const LEGACY_PHOTOGRAPHIC_FIELDS = new Set([
  'capture_method',
  'camera',
  'lens',
  'exposure_note',
  'techniques',
  'material_changes',
  'ingredients',
  'construction_note'
]);
const LEGACY_INTERVIEW_FIELDS = new Set([
  'mode',
  'instrument_id',
  'instrument_version',
  'date',
  'participants',
  'languages',
  'q1',
  'q2',
  'q3',
  'q4',
  'q5',
  'q6',
  'q7',
  'q8',
  'recording_asset_id',
  'transcript_asset_id',
  'recording_permission',
  'transcript_permission',
  'correction_note'
]);
const BASE_REQUIRED = [
  'identity.display_name',
  'identity.preferred_credit',
  'identity.record_language',
  'artwork.title',
  'artwork.title_language',
  'artwork.media_profiles',
  'artwork.canonical_asset_id',
  'context.caption',
  'files.master_availability',
  'rights.rights_basis',
  'rights.third_party_material',
  'preservation.intent'
];
export const MUSEUM_CC0_URI =
  'https://creativecommons.org/publicdomain/zero/1.0/';

/** v1/v2 objects are cloned; no historical profile or confirmation is reinterpreted. */
export function museumProfiles(
  publicationProfiles: DocumentationProfile[]
): DocumentationProfile[] {
  return publicationProfiles
    .filter((original) => original.profile_id === 'stream_artwork_basic_v1')
    .map((original) => {
      const profile = structuredClone(original);
      profile.version = 3;
      profile.review_lanes = ['curatorial', 'technical', 'rights'];
      profile.guidance_version = 'stream-museum-record-guidance-v3';
      profile.confirmation_copy_version =
        'stream-museum-record-confirmation-v3';
      profile.confirmation_copy =
        'I have reviewed this version of the artwork record, including its accounts, credits, materials and uncertainty. The answers and selected files are intended for publication with the work. Museum enrichment remains separately attributed. Questions for the team are outside the artwork record. Confirmation records this version; it does not publish or mint the work.';
      profile.required_for_review = [
        ...BASE_REQUIRED,
        'rights.intended_license',
        'rights.rights_declaration',
        'rights.declaration_effect'
      ];
      profile.limits = {
        ...profile.limits,
        context_payload_bytes: 4000000,
        write_request_bytes: 5000000,
        asset_bytes: 8 * 1024 ** 3,
        context_stored_and_reserved_bytes: 128 * 1024 ** 3,
        assets_per_context: 1000
      };
      profile.media_profiles = MUSEUM_MEDIA_PROFILES;
      profile.program_rules = {
        default_media_profiles: [],
        allowed_media_profiles: [...MEDIA_PROFILE_IDS]
      };
      profile.storage_mode = 'database_draft_and_object_storage';
      profile.modules = profile.modules.map((module) => ({
        ...module,
        fields: [
          ...module.fields.map((definition): FieldDefinition => {
            const result: FieldDefinition = {
              ...definition,
              chapter: chapter[module.id],
              label:
                FIELD_LABELS[`${module.id}.${definition.id}`] ??
                definition.id
                  .split('_')
                  .join(' ')
                  .replace(/^./, (letter) => letter.toUpperCase())
            };
            if (
              module.id === 'process' &&
              LEGACY_PHOTOGRAPHIC_FIELDS.has(definition.id)
            )
              result.media_profiles = ['photography'];
            if (
              module.id === 'artwork' &&
              ['capture_date', 'location', 'declared_dimensions'].includes(
                definition.id
              )
            )
              result.media_profiles = ['photography', 'digital_art'];
            if (
              module.id === 'interview' &&
              LEGACY_INTERVIEW_FIELDS.has(definition.id)
            )
              result.chapter = 'legacy_conversation';
            if (module.id === 'preservation')
              result.value_schema = text(150000);
            if (
              module.id === 'context' &&
              ['making_context', 'misunderstandings'].includes(definition.id)
            )
              result.value_schema = text(150000);
            if (
              module.id === 'process' &&
              definition.id === 'process_description'
            )
              result.value_schema = text(150000);
            if (module.id === 'artwork' && definition.id === 'medium')
              result.value_schema = object(
                {
                  kind: choice(
                    'digital_photograph',
                    'analogue_photograph',
                    'photographic_composite',
                    'digital_art',
                    'video',
                    'audio',
                    'html',
                    'generative',
                    'interactive',
                    'spatial',
                    'text',
                    'installation',
                    'mixed',
                    'other'
                  ),
                  detail: text(20000)
                },
                ['kind']
              );
            return result;
          }),
          ...fields[module.id]
        ].map((definition) => ({
          ...definition,
          value_schema: annotate(definition.value_schema)
        }))
      }));
      return profile;
    });
}

/** Program policy is trusted server context, never a client-supplied license. */
export function bindMuseumProgram(
  profile: DocumentationProfile,
  programId: string | null
): DocumentationProfile {
  if (profile.version !== 3 || !programId) return profile;
  if (programId !== '6529NM-AP-01') fail(422, 'UNSUPPORTED_PROGRAM');
  const bound = structuredClone(profile);
  bound.program_id = programId;
  bound.wave_id = '4ff022b3-aa17-4a0a-ba78-58f64ff1d427';
  bound.program_rules = {
    default_media_profiles: [],
    allowed_media_profiles: [...MEDIA_PROFILE_IDS],
    fixed_artwork_license: { uri: MUSEUM_CC0_URI, label: 'CC0 1.0 Universal' }
  };
  bound.required_for_review = [...BASE_REQUIRED, 'context.theme_connection'];
  bound.modules = bound.modules.map((module) => ({
    ...module,
    fields: module.fields.map((definition) =>
      module.id === 'rights' &&
      ['intended_license', 'rights_declaration', 'declaration_effect'].includes(
        definition.id
      )
        ? { ...definition, read_only: true, chapter: 'legacy_terms' }
        : definition
    )
  }));
  return bound;
}
