import type {
  ReviewLane,
  ValueSchema
} from '@/artwork-documentation/artwork-documentation.types';

const text = (title: string, maxLength = 2000): ValueSchema => ({
  type: 'string',
  title,
  minLength: 1,
  maxLength
});
const identifier = (title: string): ValueSchema => ({
  ...text(title, 36),
  format: 'uuid'
});
const choice = (title: string, ...values: string[]): ValueSchema => ({
  ...text(title, 100),
  enum: values
});
const date = (title: string): ValueSchema => ({
  ...text(title, 10),
  format: 'partial-date'
});
const fields = (
  properties: Record<string, ValueSchema>,
  required: string[]
): ValueSchema => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false
});
const instrument = identifier('Supporting instrument file');
const institution = text('Institution or responsible organization', 300);
const outcome = text('Outcome or finding', 12000);

export interface MuseumRecordDefinition {
  kind: string;
  label: string;
  description: string;
  lane: ReviewLane;
  stream_schema: string;
  value_schema: ValueSchema;
}

/** Museum statements belong to their recorders, outside the artist's confirmed account. */
export const MUSEUM_RECORD_DEFINITIONS: readonly MuseumRecordDefinition[] = [
  {
    kind: 'catalogue_note',
    label: 'Catalogue note',
    lane: 'curatorial',
    stream_schema: 'STREAM_WORK_DESCRIPTION_V1',
    description:
      'Add attributed research or a cataloguing decision, preserving the artist’s account.',
    value_schema: fields(
      { source: text('Source or basis'), conclusion: outcome },
      ['source', 'conclusion']
    )
  },
  {
    kind: 'authority_alignment',
    label: 'Authority identification',
    lane: 'curatorial',
    stream_schema: 'STREAM_SEMANTIC_ASSERTION_V1',
    description:
      'Relate a named person, place or term to a shared authority record. Preserve the evidence and the limits of the match.',
    value_schema: fields(
      {
        entity_id: identifier('Entity in this artwork record'),
        authority: choice(
          'Authority',
          'GETTY_TGN',
          'GETTY_AAT',
          'GETTY_ULAN',
          'VIAF',
          'WIKIDATA'
        ),
        identifier: text('Authority identifier', 160),
        canonical_iri: text('Canonical authority IRI', 1000),
        focus_iri: text('Real-world entity focus IRI, when supplied', 1000),
        match_kind: choice(
          'Relationship',
          'equivalent_entity',
          'close_match',
          'related_reference'
        ),
        review_status: choice(
          'Review',
          'unreviewed',
          'reviewed',
          'disputed',
          'withdrawn'
        ),
        observed_label: text('Label reviewed', 500),
        language: { ...text('Label language', 50), format: 'bcp47' },
        retrieved_date: date('Source retrieval date'),
        source_revision: text('Source revision, if supplied', 200),
        snapshot_asset_id: identifier('Archived authority record file'),
        basis: outcome
      },
      [
        'entity_id',
        'authority',
        'identifier',
        'canonical_iri',
        'match_kind',
        'review_status',
        'observed_label',
        'retrieved_date',
        'snapshot_asset_id',
        'basis'
      ]
    )
  },
  {
    kind: 'acquisition',
    label: 'Acquisition',
    lane: 'curatorial',
    stream_schema: 'STREAM_ACQUISITION_PACKET_V1',
    description:
      'Describe the acquisition and its evidence. A submitted work or token transfer alone does not establish acquisition.',
    value_schema: fields(
      {
        institution,
        acquisition_method: choice(
          'Method',
          'commission',
          'purchase',
          'gift',
          'transfer',
          'other'
        ),
        source: text('Acquired from', 500),
        title_binding_asset_id: instrument,
        accession_identifier: text('Accession identifier', 160),
        terms: text('Terms and scope', 12000)
      },
      [
        'institution',
        'acquisition_method',
        'source',
        'title_binding_asset_id',
        'terms'
      ]
    )
  },
  {
    kind: 'accession',
    label: 'Accession',
    lane: 'curatorial',
    stream_schema: 'STREAM_ACCESSION_V1',
    description:
      'Record the institution’s acceptance into its collection and the instrument identifying the accepted property.',
    value_schema: fields(
      {
        institution,
        accession_identifier: text('Accession identifier', 160),
        title_binding_asset_id: instrument,
        decision_reference: text('Authorizing decision', 2000),
        scope: text('Property accepted', 12000)
      },
      [
        'institution',
        'accession_identifier',
        'title_binding_asset_id',
        'decision_reference',
        'scope'
      ]
    )
  },
  {
    kind: 'custody',
    label: 'Custody and delivery',
    lane: 'curatorial',
    stream_schema: 'STREAM_OBJECT_DOSSIER_V1',
    description:
      'Record custody of the identified physical or digital objects separately from ownership and accession.',
    value_schema: fields(
      {
        from: text('Delivered by', 500),
        to: text('Received by', 500),
        location: text('Public location statement', 500),
        delivery_asset_id: instrument,
        scope: text('Objects and delivery scope', 12000)
      },
      ['from', 'to', 'scope']
    )
  },
  {
    kind: 'condition',
    label: 'Condition examination',
    lane: 'technical',
    stream_schema: 'STREAM_CONDITION_REPORT_V1',
    description:
      'Document an examination, its method and reference evidence. Record unverified protocol checks explicitly.',
    value_schema: fields(
      {
        examiner: text('Examiner', 500),
        method: text('Examination method', 12000),
        outcome,
        finality_check: choice(
          'Stream finality check',
          'not_available',
          'not_verified',
          'verified'
        ),
        fixity_check: choice(
          'File fixity check',
          'not_verified',
          'verified',
          'mismatch'
        ),
        rendering_check: choice(
          'Reference presentation check',
          'not_verified',
          'matches',
          'differs'
        ),
        verification_asset_id: identifier('Verification report file'),
        recovery_lineage: text('Recovery history or explicit none known', 12000)
      },
      [
        'examiner',
        'method',
        'outcome',
        'finality_check',
        'fixity_check',
        'rendering_check',
        'recovery_lineage'
      ]
    )
  },
  {
    kind: 'exhibition',
    label: 'Exhibition',
    lane: 'curatorial',
    stream_schema: 'STREAM_EXHIBITION_V1',
    description:
      'Describe a particular presentation, its venue, dates and the versions or components shown.',
    value_schema: fields(
      {
        venue: text('Venue', 500),
        organizer: institution,
        start: date('Opening date'),
        end: date('Closing date'),
        presentation: text('Presentation and installation', 12000),
        catalogue_reference: text('Catalogue or publication', 2000)
      },
      ['venue', 'organizer', 'start', 'presentation']
    )
  },
  {
    kind: 'loan',
    label: 'Loan and return',
    lane: 'curatorial',
    stream_schema: 'STREAM_LOAN_V1',
    description:
      'Record the parties, conditions and examination references for a loan and its return.',
    value_schema: fields(
      {
        lender: text('Lender', 500),
        borrower: text('Borrower', 500),
        start: date('Loan start'),
        expected_return: date('Expected return'),
        returned: date('Actual return'),
        agreement_asset_id: instrument,
        outbound_condition_record_id: identifier('Outbound examination record'),
        return_condition_record_id: identifier('Return examination record'),
        conditions: text('Loan conditions', 12000)
      },
      [
        'lender',
        'borrower',
        'start',
        'agreement_asset_id',
        'outbound_condition_record_id',
        'conditions'
      ]
    )
  },
  {
    kind: 'preservation',
    label: 'Preservation activity',
    lane: 'technical',
    stream_schema: 'STREAM_PREMIS_V3_PROFILE',
    description:
      'Record the specific objects, responsible people or software, method and outcome of preservation work.',
    value_schema: fields(
      {
        event_type: choice(
          'Activity',
          'INGEST',
          'FIXITY_CHECK',
          'REPLICATION',
          'MIGRATION',
          'NORMALIZATION',
          'VALIDATION',
          'MEDIA_DERIVATION',
          'C2PA_VALIDATION',
          'SCHEMA_MIGRATION',
          'RIGHTS_REVIEW',
          'CONSERVATION_NOTE'
        ),
        agent: text('Responsible person or software', 500),
        method: text('Method and tool version', 12000),
        outcome,
        input_asset_ids: {
          type: 'array',
          title: 'Input files',
          items: identifier('File'),
          maxItems: 100
        },
        output_asset_ids: {
          type: 'array',
          title: 'Output files',
          items: identifier('File'),
          maxItems: 100
        },
        report_asset_id: instrument
      },
      ['event_type', 'agent', 'method', 'outcome']
    )
  },
  {
    kind: 'citation',
    label: 'Citation or publication',
    lane: 'curatorial',
    stream_schema: 'STREAM_CITATION_RECORD_V1',
    description:
      'Preserve a citation, including printed or unpublished sources that have no web address.',
    value_schema: fields(
      {
        author: text('Author or editor', 500),
        publication_title: text('Publication or source title', 1000),
        date: date('Publication date'),
        locator: text('Pages, section or other locator', 500),
        identifier: text('ISBN, DOI, URI or catalogue identifier', 1000),
        context: outcome
      },
      ['publication_title', 'context']
    )
  },
  {
    kind: 'rights',
    label: 'Rights record',
    lane: 'rights',
    stream_schema: 'STREAM_RIGHTS_V1',
    description:
      'Record the scope and supporting instrument for a rights statement, without changing the artist’s program terms.',
    value_schema: fields(
      {
        basis: choice(
          'Basis',
          'copyright',
          'license',
          'statute',
          'public_domain',
          'contract',
          'unspecified'
        ),
        licensor: text('Licensor or declaring party', 500),
        scope: text('Work, files or contributions covered', 12000),
        instrument_asset_id: instrument,
        effective_date: date('Effective date'),
        uses: text('Permitted uses and conditions', 12000)
      },
      ['basis', 'licensor', 'scope', 'instrument_asset_id', 'uses']
    )
  },
  {
    kind: 'valuation',
    label: 'Valuation',
    lane: 'curatorial',
    stream_schema: 'STREAM_VALUATION_V1',
    description:
      'Record a valuation intended for this public artwork record, with its date, basis and instrument.',
    value_schema: fields(
      {
        amount: text('Amount as stated', 100),
        currency: text('Currency', 20),
        basis: text('Basis of valuation', 2000),
        appraiser: text('Responsible appraiser', 500),
        instrument_asset_id: instrument
      },
      ['amount', 'currency', 'basis', 'appraiser', 'instrument_asset_id']
    )
  },
  {
    kind: 'stewardship',
    label: 'Stewardship',
    lane: 'curatorial',
    stream_schema: 'STREAM_STEWARD_DESIGNATION_V1',
    description:
      'Identify the designated steward and the scope of their responsibility.',
    value_schema: fields(
      {
        steward: text('Steward', 500),
        scope: text('Responsibility', 12000),
        public_contact: text('Public contact endpoint', 1000),
        designation_asset_id: instrument
      },
      ['steward', 'scope', 'designation_asset_id']
    )
  },
  {
    kind: 'recovery',
    label: 'Recovery response',
    lane: 'technical',
    stream_schema: 'STREAM_RECOVERY_RESPONSE_V1',
    description:
      'Record a response to an identified recovery proposal or event, including its supporting evidence.',
    value_schema: fields(
      {
        recovery_identifier: text('Recovery identifier', 500),
        response: choice('Response', 'acknowledged', 'objected'),
        manifest_asset_id: instrument,
        grounds: outcome
      },
      ['recovery_identifier', 'response', 'manifest_asset_id', 'grounds']
    )
  },
  {
    kind: 'deaccession',
    label: 'Deaccession',
    lane: 'curatorial',
    stream_schema: 'STREAM_DEACCESSION_V1',
    description:
      'Document an authorized deaccession decision and disposition. Creating this record does not execute the decision.',
    value_schema: fields(
      {
        institution,
        reason: outcome,
        decision_reference: text('Authorizing decision', 2000),
        title_binding_asset_id: instrument,
        disposition: text('Disposition', 12000)
      },
      [
        'institution',
        'reason',
        'decision_reference',
        'title_binding_asset_id',
        'disposition'
      ]
    )
  },
  {
    kind: 'redemption',
    label: 'Physical entitlement or redemption',
    lane: 'curatorial',
    stream_schema: 'STREAM_REDEMPTION_CLAIM_V1',
    description:
      'Describe an actual entitlement and its fulfillment evidence without inferring it from ownership of a token.',
    value_schema: fields(
      {
        program_identifier: text('Program identifier', 300),
        entitlement: text('Entitlement', 12000),
        fulfillment: text('Fulfillment status and scope', 12000),
        fulfillment_asset_id: instrument
      },
      ['program_identifier', 'entitlement', 'fulfillment']
    )
  }
];

export function museumRecordDefinition(
  kind: string
): MuseumRecordDefinition | undefined {
  return MUSEUM_RECORD_DEFINITIONS.find(
    (definition) => definition.kind === kind
  );
}
