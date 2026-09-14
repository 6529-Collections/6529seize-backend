import {
  emptyModules,
  getProfile
} from '../../artwork-documentation.catalogue';
import { Answer, ContextRecord, Json } from '../../artwork-documentation.types';
import { digest } from '../../artwork-documentation.validation';
import {
  buildLinkedArtExport,
  LINKED_ART_PROFILE_LOCK,
  validateLinkedArtProjection
} from './linked-art';

const ids = Array.from(
  { length: 20 },
  (_, index) => `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
);
const provided = (value: Json): Answer => ({
  status: 'provided',
  value,
  intended_visibility: 'public_record'
});
function context(media = ['photography']): ContextRecord {
  return JSON.parse(
    JSON.stringify({
      id: ids[0],
      work_id: ids[1],
      owner_profile_id: 'artist-profile',
      program_id: null,
      profile: getProfile('stream_artwork_basic_v1', 3),
      draft_version: 1,
      artist_record_revision_id: null,
      latest_revision_id: null,
      lifecycle: 'active',
      modules: {
        ...emptyModules(),
        artwork: {
          title: provided('AN ALTERATION'),
          media_profiles: provided(media),
          canonical_asset_id: provided(ids[2])
        }
      },
      asset_links: [
        {
          id: ids[3],
          asset_id: ids[2],
          role: 'artwork_final',
          label: 'Final master',
          description: '',
          intended_visibility: 'public_record',
          source_of_asset: 'artist',
          source_credit: '',
          derived_from_asset_ids: [],
          deposit_note: '',
          intended_terms: { kind: 'unspecified' },
          manifest: {
            filename: 'master.tif',
            detected_mime: 'image/tiff',
            size_bytes: 1000,
            sha256: 'a'.repeat(64)
          }
        }
      ],
      restricted_paths: [],
      created_at: 0,
      updated_at: 0
    })
  );
}
const id = (index: number) => `urn:uuid:${ids[index]}`;

describe('Stream draft Linked Art / CIDOC projection', () => {
  it('keeps a photographic work, its digital master and a physical print distinct with exact scoped measurements', () => {
    const record = context();
    record.modules.artwork.physical_objects = provided([
      {
        id: ids[4],
        kind: 'print',
        name: 'Reference print',
        materials: 'Pigment ink on cotton rag paper',
        status: 'described'
      }
    ]);
    record.modules.artwork.measurements = provided([
      {
        id: ids[5],
        subject_id: ids[4],
        kind: 'width',
        scope: 'image',
        value: 120,
        unit: 'cm'
      },
      {
        id: ids[6],
        subject_id: ids[4],
        kind: 'width',
        scope: 'sheet',
        value: 140,
        unit: 'cm'
      }
    ]);
    const result = buildLinkedArtExport(record);
    expect(result.resources.find((entity) => entity.id === id(1))?.type).toBe(
      'VisualItem'
    );
    expect(
      result.resources.find((entity) => entity.id === id(2))
    ).toMatchObject({
      type: 'DigitalObject',
      digitally_shows: [{ id: id(1), type: 'VisualItem' }]
    });
    const print = result.resources.find((entity) => entity.id === id(4))!;
    expect(print.type).toBe('HumanMadeObject');
    expect(print.dimension).toMatchObject([
      { value: 120, _label: 'image width: 120 cm' },
      { value: 140, _label: 'sheet width: 140 cm' }
    ]);
    expect(JSON.stringify(result.resources)).not.toContain('current_owner');
    expect(result.validation.http_api_conformance).toBe(false);
  });

  it.each([
    'audio',
    'video',
    'html',
    'generative',
    'interactive',
    'spatial',
    'installation'
  ])(
    'retains %s content in the CRM extension graph rather than misclassifying it as text or a photograph',
    (media) => {
      const record = context([media]);
      const result = buildLinkedArtExport(record);
      expect(
        result.crm_extensions.find((entity) => entity.id === id(1))?.type
      ).toBe('InformationObject');
      const file = result.resources.find((entity) => entity.id === id(2))!;
      expect(file.digitally_carries).toBeUndefined();
      expect(file.digitally_shows).toBeUndefined();
      expect(result.source_snapshot).toMatchObject({
        modules: { artwork: { media_profiles: provided([media]) } }
      });
    }
  );

  it('uses linguistic content for an explicitly textual work and a DigitalObject for its carrier', () => {
    const result = buildLinkedArtExport(context(['text']));
    expect(result.resources.find((entity) => entity.id === id(1))?.type).toBe(
      'LinguisticObject'
    );
    expect(
      result.resources.find((entity) => entity.id === id(2))?.digitally_carries
    ).toMatchObject([{ id: id(1), type: 'LinguisticObject' }]);
  });

  it('does not promote an artist authority proposal to a reviewed equivalence or a place of creation', () => {
    const record = context();
    record.modules.artwork.places = provided([
      {
        id: ids[4],
        name: 'Milos, Greece',
        role: 'depicted',
        certainty: 'known',
        authorities: [
          {
            authority: 'TGN',
            identifier: '123',
            uri: 'http://vocab.getty.edu/tgn/123',
            label: 'Candidate record',
            match: 'exact',
            evidence: 'Artist proposal; museum review has not occurred.'
          }
        ]
      }
    ]);
    const result = buildLinkedArtExport(record);
    const place = result.resources.find((entity) => entity.id === id(4))!;
    expect(place.type).toBe('Place');
    expect(place.equivalent).toBeUndefined();
    expect(
      result.resources.find((entity) => entity.id === id(1))?.represents
    ).toMatchObject([{ id: id(4), type: 'Place' }]);
    expect(JSON.stringify(result.resources)).not.toContain('took_place_at');
    expect(JSON.stringify(result.source_snapshot)).toContain(
      'http://vocab.getty.edu/tgn/123'
    );
  });

  it('keeps capture, completion and interview dates separate, and does not invent exact bounds for an approximate date', () => {
    const record = context();
    record.modules.context.events = provided([
      {
        id: ids[4],
        kind: 'capture',
        title: 'Capture',
        date: { precision: 'day', start: '2026-05-18', approximate: false },
        subject_ids: [ids[1]],
        account: 'The photograph was captured.'
      },
      {
        id: ids[5],
        kind: 'completion',
        title: 'Completion',
        date: { precision: 'day', start: '2026-05-24', approximate: false },
        subject_ids: [ids[1]],
        account: 'The tonal editing was completed.'
      },
      {
        id: ids[6],
        kind: 'interview',
        title: 'Conversation',
        date: { precision: 'month', start: '2026-06', approximate: true },
        subject_ids: [ids[1]],
        account: 'A conversation in early June.'
      }
    ]);
    const result = buildLinkedArtExport(record);
    expect(
      result.resources.find((entity) => entity.id === id(4))
    ).toMatchObject({
      type: 'Creation',
      timespan: {
        begin_of_the_begin: '2026-05-18T00:00:00.000Z',
        end_of_the_end: '2026-05-19T00:00:00.000Z'
      }
    });
    expect(result.resources.find((entity) => entity.id === id(5))?.type).toBe(
      'Activity'
    );
    const interview = result.resources.find((entity) => entity.id === id(6))!;
    expect(interview.timespan).not.toHaveProperty('begin_of_the_begin');
    expect(
      result.resources.find((entity) => entity.id === id(1))?.created_by
    ).toMatchObject({ id: id(4) });
  });

  it('does not select one of two competing creation-event assertions by iteration order', () => {
    const record = context();
    record.modules.context.events = provided([
      {
        id: ids[4],
        kind: 'creation',
        title: 'First account',
        subject_ids: [ids[1]],
        account: 'An account of creation.'
      },
      {
        id: ids[5],
        kind: 'creation',
        title: 'Another account',
        subject_ids: [ids[1]],
        account: 'A different creation account needing reconciliation.'
      }
    ]);
    const result = buildLinkedArtExport(record);
    expect(
      result.resources.find((entity) => entity.id === id(1))?.created_by
    ).toBeUndefined();
    expect(result.ambiguous_activity_subjects).toContain(`${id(1)}:created_by`);
    expect(
      result.resources.filter((entity) => entity.type === 'Creation')
    ).toHaveLength(2);
  });

  it('preserves an attributed written interview without asserting that an audio recording exists', () => {
    const record = context();
    record.modules.identity.agents = provided([
      { id: ids[4], kind: 'person', name: 'Elia Maris' },
      { id: ids[5], kind: 'person', name: 'Leonie Karras' },
      {
        id: ids[6],
        kind: 'software',
        name: 'Transcription software',
        version: '1'
      }
    ]);
    record.modules.interview.sessions = provided([
      {
        id: ids[7],
        title: 'Conversation',
        date: { precision: 'day', start: '2026-06-02', approximate: false },
        language: 'en',
        mode: 'written',
        participants: [
          { agent_id: ids[4], role: 'artist' },
          { agent_id: ids[5], role: 'interviewer' }
        ],
        instrument: {
          id: 'custom',
          version: '1',
          title: 'Questions',
          questions: []
        },
        transcript_text:
          'Interviewer: What changed?\nArtist: A gate interrupted the passage.',
        publication_permission: 'intended_public_record'
      }
    ]);
    const result = buildLinkedArtExport(record);
    const activity = result.resources.find((entity) => entity.id === id(7))!;
    expect(activity.carried_out_by).toMatchObject([
      { id: id(4), type: 'Person' },
      { id: id(5), type: 'Person' }
    ]);
    expect(
      result.crm_extensions.find((entity) => entity.id === id(6))?.type
    ).toBe('InformationObject');
    expect(
      result.resources.filter((entity) => entity.type === 'DigitalObject')
    ).toHaveLength(1);
    expect(
      result.resources.some(
        (entity) =>
          entity.content ===
          'Interviewer: What changed?\nArtist: A gate interrupted the passage.'
      )
    ).toBe(true);
  });

  it('is deterministic, accounts for every source field, and anchors emitted claims in existing source pointers', () => {
    const record = context(['photography', 'html']);
    record.modules.process.html = provided({
      entry_document: 'index.html',
      offline_behavior: 'Self-contained package.'
    });
    record.modules.artwork.capture_date = {
      status: 'unknown',
      explanation: 'Date not established.',
      intended_visibility: 'public_record'
    };
    const result = buildLinkedArtExport(record);
    expect(digest(result)).toBe(digest(buildLinkedArtExport(record)));
    expect(result.coverage).toContainEqual({
      source_pointer: '/modules/process/html/value',
      disposition: 'retained_stream_only',
      rule: 'source-account-retained-without-lossy-standard-property'
    });
    expect(
      result.coverage.some(
        (entry) => entry.source_pointer === '/modules/artwork/capture_date'
      )
    ).toBe(true);
    for (const claim of result.provenance_index)
      for (const source of claim.sources)
        for (const path of source.source_pointers) {
          const value = path
            .split('/')
            .filter(Boolean)
            .reduce<unknown>(
              (node, key) => (node as Record<string, unknown>)[key],
              result.source_snapshot
            );
          expect(value).toBeDefined();
        }
    expect(result.status).toBe('incomplete');
    expect(result.profile_lock.context_canonical_sha256).toBe(
      LINKED_ART_PROFILE_LOCK.context_canonical_sha256
    );
  });

  it('rejects class-domain violations instead of claiming a successful standard projection', () => {
    const invalid = {
      id: id(2),
      type: 'DigitalObject',
      digitally_carries: [{ id: id(1), type: 'VisualItem' }]
    };
    expect(() =>
      validateLinkedArtProjection(
        [invalid, { id: id(1), type: 'VisualItem' }],
        []
      )
    ).toThrow('Invalid digitally_carries target');
    expect(() =>
      validateLinkedArtProjection(
        [
          {
            id: id(2),
            type: 'DigitalObject',
            produced_by: { id: id(4), type: 'Production' }
          }
        ],
        []
      )
    ).toThrow('Invalid produced_by subject');
  });

  function alignment(record: ContextRecord, number = 1, review = 'reviewed') {
    return {
      id: ids[8 + number],
      context_id: record.id,
      actor_profile_id: 'museum-curator',
      kind: 'authority_alignment',
      source_draft_version: 1,
      source_revision_id: null,
      supersedes_id: null,
      created_at: Date.UTC(2026, 8, 12),
      sha256: 'c'.repeat(64),
      payload_json: {
        title: 'Place identification',
        event_status: 'completed',
        subject_ids: [ids[4]],
        evidence_asset_ids: [ids[2]],
        details: {
          entity_id: ids[4],
          authority: 'GETTY_TGN',
          identifier: String(number),
          canonical_iri: `http://vocab.getty.edu/tgn/${number}`,
          focus_iri: `http://vocab.getty.edu/tgn/${number}-place`,
          match_kind: 'equivalent_entity',
          review_status: review,
          observed_label: 'Reviewed authority label',
          retrieved_date: '2026-09-12',
          snapshot_asset_id: ids[2],
          basis:
            'Record identity and geographic context checked against the archived source.'
        }
      }
    };
  }
  function locatedContext() {
    const record = context();
    record.modules.artwork.places = provided([
      {
        id: ids[4],
        name: 'Artist place name',
        role: 'depicted',
        certainty: 'known'
      }
    ]);
    return record;
  }
  it('projects a reviewed authority assignment with its real recorder, archived evidence and canonical identity', () => {
    const record = locatedContext();
    const row = alignment(record);
    const result = buildLinkedArtExport(record, [row]);
    const place = result.resources.find((entity) => entity.id === id(4))!;
    expect(place._label).toBe('Artist place name');
    expect(place.equivalent).toEqual([
      {
        id: 'http://vocab.getty.edu/tgn/1',
        type: 'Place',
        _label: 'Reviewed authority label'
      }
    ]);
    const assertion = result.resources.find(
      (entity) => entity.type === 'AttributeAssignment'
    )!;
    expect(assertion.assigned_property).toBe('equivalent');
    expect(assertion.used_specific_object).toMatchObject([
      { id: id(2), type: 'DigitalObject' }
    ]);
    expect(assertion.carried_out_by).toMatchObject([
      { type: 'Actor', _label: 'Recorder using 6529 profile museum-curator' }
    ]);
    expect(result.source_snapshot).toMatchObject({
      museum_records: [
        {
          payload_json: {
            details: { focus_iri: 'http://vocab.getty.edu/tgn/1-place' }
          }
        }
      ]
    });
    expect(
      result.provenance_index
        .filter((claim) => claim.entity_id === assertion.id)
        .every((claim) =>
          claim.sources.some((source) =>
            source.source_pointers.includes('/museum_records/0')
          )
        )
    ).toBe(true);
  });
  it('retains conflicting reviewed assignments without selecting the latest one as direct equivalence', () => {
    const record = locatedContext();
    const result = buildLinkedArtExport(record, [
      alignment(record, 1),
      alignment(record, 2)
    ]);
    expect(
      result.resources.find((entity) => entity.id === id(4))?.equivalent
    ).toBeUndefined();
    expect(
      result.resources.filter((entity) => entity.type === 'AttributeAssignment')
    ).toHaveLength(2);
    expect(result.authority_conflicts).toEqual([
      '/museum_records/0',
      '/museum_records/1'
    ]);
  });
  it.each(['unreviewed', 'withdrawn', 'disputed'])(
    'does not promote %s journal alignments to authority equivalents',
    (review) => {
      const record = locatedContext();
      const result = buildLinkedArtExport(record, [
        alignment(record, 1, review)
      ]);
      expect(
        result.resources.find((entity) => entity.id === id(4))?.equivalent
      ).toBeUndefined();
      expect(
        result.resources.some((entity) => entity.type === 'AttributeAssignment')
      ).toBe(false);
    }
  );
  it('requires evidence bytes and honors explicit authority withdrawal without erasing the original claim', () => {
    const record = locatedContext();
    record.asset_links[0].manifest.sha256 = null;
    expect(
      buildLinkedArtExport(record, [alignment(record)]).resources.find(
        (entity) => entity.id === id(4)
      )?.equivalent
    ).toBeUndefined();
    record.asset_links[0].manifest.sha256 = 'a'.repeat(64);
    const prior = alignment(record);
    const withdrawn = {
      ...alignment(record, 2, 'withdrawn'),
      supersedes_id: prior.id
    };
    const result = buildLinkedArtExport(record, [prior, withdrawn]);
    expect(
      result.resources.find((entity) => entity.id === id(4))?.equivalent
    ).toBeUndefined();
    expect(
      result.resources.some((entity) => entity.id === `urn:uuid:${prior.id}`)
    ).toBe(true);
  });
});
