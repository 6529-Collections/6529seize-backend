import { MEDIA_CAPTURE_ACCOUNTS as examples } from './fixtures/media-accounts';
import {
  applyOperations,
  emptyModules,
  getProfile,
  PROFILES
} from '../artwork-documentation.catalogue';
import {
  Answer,
  ContextRecord,
  Json,
  ModuleId
} from '../artwork-documentation.types';
import { digest, matchesSchema } from '../artwork-documentation.validation';
import { bindMuseumProgram, MUSEUM_CC0_URI } from './museum-catalogue';
import { MUSEUM_MEDIA_FIELDS } from './museum-media';
import { MEDIA_PROFILE_IDS } from './museum-record.types';
import {
  museumAssetReferences,
  museumRecordIssues,
  museumRequired,
  validateMuseumDraft
} from './museum-validation';
import { museumUpgradePreview } from './museum-upgrade';

const ids = Array.from(
  { length: 20 },
  (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
);
const provided = (value: Json): Answer => ({
  status: 'provided',
  value,
  intended_visibility: 'public_record'
});
const date = { precision: 'day', start: '2026-05-18', approximate: false };
function context(): ContextRecord {
  return {
    id: ids[0],
    work_id: ids[1],
    owner_profile_id: 'artist-profile',
    program_id: null,
    profile: getProfile('stream_artwork_basic_v1', 3),
    draft_version: 1,
    artist_record_revision_id: null,
    latest_revision_id: null,
    lifecycle: 'active',
    modules: emptyModules(),
    asset_links: [],
    restricted_paths: [],
    created_at: 0,
    updated_at: 0
  };
}
function set(
  record: ContextRecord,
  moduleId: ModuleId,
  field: string,
  value: Json
): void {
  record.modules[moduleId] = applyOperations(
    moduleId,
    record.modules[moduleId],
    [{ op: 'set', field, answer: provided(value) }],
    record.profile
  );
}

describe('general museum record profile', () => {
  it('captures documentary token references without rounding uint256 identifiers or claiming a verified binding', () => {
    const record = context();
    const token = {
      id: ids[2],
      chain_namespace: 'eip155',
      chain_id: '1',
      contract_address: '0x1111111111111111111111111111111111111111',
      token_id:
        '115792089237316195423570985008687907853269984665640564039457584007913129639935',
      token_standard: 'erc721',
      relationship: 'represents_work'
    };
    set(record, 'artwork', 'token_references', [token]);
    expect(record.modules.artwork.token_references.value).toEqual([token]);
    expect(() =>
      set(record, 'artwork', 'token_references', [
        {
          ...token,
          token_id:
            '115792089237316195423570985008687907853269984665640564039457584007913129639936'
        }
      ])
    ).toThrow('INVALID_VALUE');
    expect(() =>
      set(record, 'artwork', 'token_references', [{ ...token, verified: true }])
    ).toThrow('INVALID_VALUE');
    expect(() =>
      set(record, 'artwork', 'token_references', [{ ...token, token_id: 123 }])
    ).toThrow('INVALID_VALUE');
  });

  it('rejects executable entry paths that escape a deposited package', () => {
    for (const entry_document of [
      '../outside.html',
      '/index.html',
      'https://example.org/index.html',
      'C:\\index.html'
    ]) {
      const record = context();
      set(record, 'process', 'html', {
        ...(examples.html as Record<string, Json>),
        entry_document
      });
      expect(() => validateMuseumDraft(record)).toThrow(
        'INVALID_ENTRY_DOCUMENT'
      );
    }
    const record = context();
    set(record, 'process', 'html', {
      ...(examples.html as Record<string, Json>),
      entry_document: 'work/index.html'
    });
    expect(() => validateMuseumDraft(record)).not.toThrow();
  });
  it('has one general v3 model; binding program terms does not force a medium or change historical profiles', () => {
    const before = digest(
      JSON.parse(
        JSON.stringify(PROFILES.filter((profile) => profile.version < 3))
      )
    );
    const generic = getProfile('stream_artwork_basic_v1', 3);
    const bound = bindMuseumProgram(generic, '6529NM-AP-01');
    expect(PROFILES.filter((profile) => profile.version === 3)).toHaveLength(1);
    expect(bound.profile_id).toBe(generic.profile_id);
    expect(bound.program_rules).toMatchObject({
      default_media_profiles: [],
      fixed_artwork_license: { uri: MUSEUM_CC0_URI }
    });
    expect(generic.program_id).toBeNull();
    expect(
      digest(
        JSON.parse(
          JSON.stringify(PROFILES.filter((profile) => profile.version < 3))
        )
      )
    ).toBe(before);
    expect(() => bindMuseumProgram(generic, 'unconfigured-program')).toThrow(
      'UNSUPPORTED_PROGRAM'
    );
    expect(() =>
      applyOperations(
        'rights',
        {},
        [
          {
            op: 'set',
            field: 'intended_license',
            answer: provided({
              uri: 'https://example.org/license',
              label: 'Another license'
            })
          }
        ],
        bound
      )
    ).toThrow('PROGRAM_TERMS_FIXED');
    expect(() =>
      applyOperations(
        'rights',
        {},
        [{ op: 'unset', field: 'intended_license' }],
        bound
      )
    ).toThrow('PROGRAM_TERMS_FIXED');
  });

  it.each(MEDIA_PROFILE_IDS)(
    'accepts a substantive %s account and rejects missing essential presentation knowledge',
    (id) => {
      const record = context();
      set(record, 'artwork', 'media_profiles', [id]);
      expect(museumRequired(record.modules)).toEqual([`process.${id}`]);
      set(record, 'process', id, examples[id]);
      const schema = MUSEUM_MEDIA_FIELDS.find(
        (field) => field.id === id
      )!.value_schema;
      const incomplete = { ...(examples[id] as Record<string, Json>) };
      delete incomplete[schema.required![0]];
      expect(matchesSchema(incomplete, schema)).toBe(false);
      expect(record.modules.process[id].value).toEqual(examples[id]);
    }
  );

  it('composes photography, web and interaction without deleting an earlier account when selection changes', () => {
    const record = context();
    set(record, 'artwork', 'media_profiles', [
      'photography',
      'html',
      'interactive'
    ]);
    for (const id of ['photography', 'html', 'interactive'])
      set(record, 'process', id, examples[id]);
    expect(museumRecordIssues(record)).toEqual([]);
    set(record, 'artwork', 'media_profiles', ['html', 'interactive']);
    expect(record.modules.process.photography.value).toEqual(
      examples.photography
    );
    expect(museumRequired(record.modules)).toEqual([
      'process.html',
      'process.interactive'
    ]);
    expect(() =>
      set(record, 'artwork', 'media_profiles', ['html', 'html'])
    ).toThrow('INVALID_VALUE');
    expect(() =>
      set(record, 'artwork', 'media_profiles', ['not_a_medium'])
    ).toThrow('INVALID_VALUE');
  });

  it('keeps complete printing instructions and a full written interview without inventing a recording', () => {
    const record = context();
    const printing =
      'The complete image and sheet are separately measured. Retain the reference proof as the visual standard.\n\n'.repeat(
        80
      );
    const transcript =
      'Interviewer: What drew you to the passage?\nArtist: I returned to find the familiar view altered by a gate.\n\n'.repeat(
        130
      );
    set(record, 'identity', 'agents', [
      { id: ids[2], kind: 'person', name: 'Elia Maris' },
      { id: ids[3], kind: 'person', name: 'Leonie Karras' }
    ]);
    set(record, 'preservation', 'print_preferences', printing);
    set(record, 'context', 'documents', [
      {
        id: ids[4],
        kind: 'printing',
        title: 'Printing instructions',
        language: 'en',
        text: printing,
        authors: [{ agent_id: ids[2], role: 'author' }],
        authorship: 'original',
        review_status: 'author_reviewed'
      }
    ]);
    set(record, 'interview', 'sessions', [
      {
        id: ids[5],
        title: 'Conversation about An Alteration',
        date,
        language: 'en',
        mode: 'written',
        participants: [
          { agent_id: ids[2], role: 'artist' },
          { agent_id: ids[3], role: 'interviewer' }
        ],
        instrument: {
          id: 'an-alteration-conversation',
          version: '1',
          title: 'Questions for Elia Maris',
          questions: [{ id: 'passage', text: 'What drew you to the passage?' }]
        },
        transcript_text: transcript,
        publication_permission: 'intended_public_record'
      }
    ]);
    validateMuseumDraft(record);
    expect(museumRecordIssues(record)).toEqual([]);
    expect(record.modules.preservation.print_preferences.value).toBe(printing);
    expect(
      (record.modules.interview.sessions.value as Record<string, Json>[])[0]
        .transcript_text
    ).toBe(transcript);
    expect(museumAssetReferences(record.modules.interview)).toEqual([]);
  });

  it('represents a physical print and separate image/sheet dimensions without merging them into a file', () => {
    const record = context();
    set(record, 'artwork', 'physical_objects', [
      {
        id: ids[2],
        kind: 'print',
        name: 'Reference print',
        materials: 'Pigment ink on cotton rag paper',
        status: 'described'
      }
    ]);
    set(record, 'artwork', 'measurements', [
      {
        id: ids[3],
        subject_id: ids[2],
        kind: 'width',
        scope: 'image',
        value: 120,
        unit: 'cm'
      },
      {
        id: ids[4],
        subject_id: ids[2],
        kind: 'width',
        scope: 'sheet',
        value: 140,
        unit: 'cm'
      }
    ]);
    validateMuseumDraft(record);
    expect(museumRecordIssues(record)).toEqual([]);
    set(record, 'artwork', 'components', [
      {
        id: ids[2],
        kind: 'visual_content',
        name: 'The image',
        description: 'The image is distinct from the physical reference print.'
      }
    ]);
    expect(() => validateMuseumDraft(record)).toThrow('DUPLICATE_MUSEUM_ID');
  });

  it('allows unfinished entity links in drafts but identifies wrong-type and unresolved links for confirmation', () => {
    const record = context();
    set(record, 'context', 'documents', [
      {
        id: ids[2],
        kind: 'artist_statement',
        title: 'Account',
        language: 'en',
        text: 'The artist account.',
        authors: [{ agent_id: ids[3], role: 'author' }],
        authorship: 'original',
        review_status: 'draft'
      }
    ]);
    expect(() => validateMuseumDraft(record)).not.toThrow();
    expect(museumRecordIssues(record)).toContainEqual({
      field: 'context.documents',
      code: 'MUSEUM_REFERENCE_UNRESOLVED',
      lane: 'curatorial'
    });
    set(record, 'identity', 'agents', [
      { id: ids[3], kind: 'person', name: 'Artist' }
    ]);
    expect(museumRecordIssues(record)).toEqual([]);
  });

  it('rejects impossible dates, mismatched TGN identities and reversed time segments', () => {
    const record = context();
    expect(() =>
      set(record, 'artwork', 'places', [
        {
          id: ids[2],
          name: 'Milos',
          role: 'capture',
          certainty: 'known',
          date: { ...date, start: '2026-02-30' }
        }
      ])
    ).toThrow('INVALID_VALUE');
    set(record, 'artwork', 'places', [
      {
        id: ids[2],
        name: 'A place',
        role: 'depicted',
        certainty: 'uncertain',
        authorities: [
          {
            authority: 'TGN',
            identifier: '123',
            uri: 'http://vocab.getty.edu/tgn/456',
            label: 'Authority label',
            match: 'suggested',
            evidence: 'An unreviewed comparison of the labels.'
          }
        ]
      }
    ]);
    expect(() => validateMuseumDraft(record)).toThrow('INVALID_TGN_IDENTITY');
  });

  it('finds nested asset references without dropping recordings, captions, sources or dependencies', () => {
    const answers = {
      sessions: provided([
        {
          id: ids[2],
          instrument: { asset_id: ids[3] },
          recording_asset_ids: [ids[4], ids[5]],
          caption_asset_ids: [ids[6]],
          transcript_asset_id: ids[7]
        }
      ]),
      html: provided({
        dependencies: [{ asset_id: ids[8] }],
        package_asset_ids: [ids[9]]
      })
    };
    expect(
      museumAssetReferences(answers)
        .map((reference) => reference.id)
        .sort((a, b) => a.localeCompare(b))
    ).toEqual(ids.slice(3, 10));
  });

  it('requires source text for text works and a transcript plus recording for recorded interviews', () => {
    const record = context();
    set(record, 'artwork', 'media_profiles', ['text']);
    const withoutText = { ...(examples.text as Record<string, Json>) };
    delete withoutText.authoritative_text;
    set(record, 'process', 'text', withoutText);
    expect(museumRecordIssues(record)).toContainEqual({
      field: 'process.text',
      code: 'AUTHORITATIVE_TEXT_REQUIRED',
      lane: 'curatorial'
    });
    set(record, 'interview', 'sessions', [
      {
        id: ids[2],
        title: 'Recorded conversation',
        date,
        language: 'en',
        mode: 'audio',
        participants: [{ agent_id: ids[3], role: 'artist' }],
        instrument: {
          id: 'conversation',
          version: '1',
          title: 'Conversation',
          questions: []
        },
        publication_permission: 'intended_public_record'
      }
    ]);
    expect(museumRecordIssues(record).map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        'INTERVIEW_TRANSCRIPT_REQUIRED',
        'INTERVIEW_RECORDING_REQUIRED'
      ])
    );
  });

  it('preserves old answers and confirmations in an upgrade preview and names incompatible private answers', () => {
    const record = context();
    record.profile = getProfile('keys_and_gates_v1', 2);
    record.program_id = '6529NM-AP-01';
    record.latest_revision_id = ids[10];
    record.modules.artwork.title = provided('AN ALTERATION');
    record.modules.rights.intended_license = provided({
      uri: MUSEUM_CC0_URI,
      label: 'CC0'
    });
    const before = digest(JSON.parse(JSON.stringify(record)));
    const proposed = bindMuseumProgram(
      getProfile('stream_artwork_basic_v1', 3),
      record.program_id
    );
    expect(museumUpgradePreview(record, proposed).retained_fields).toEqual([
      'artwork.title',
      'rights.intended_license'
    ]);
    expect(museumUpgradePreview(record, proposed).blocking_fields).toEqual([]);
    expect(digest(JSON.parse(JSON.stringify(record)))).toBe(before);
    record.modules.identity.private_contact = {
      ...provided('Contact account'),
      intended_visibility: 'restricted'
    };
    expect(museumUpgradePreview(record, proposed).blocking_fields).toEqual([
      'identity.private_contact'
    ]);
  });

  it('preserves artist presentation order and rejects impossible scene regions or timing', () => {
    const record = context();
    const scene = {
      id: ids[2],
      title: 'Opening',
      width: 1920,
      height: 1080,
      duration_seconds: 20,
      resources: [
        {
          asset_id: ids[3],
          role: 'painting',
          start_seconds: 0,
          end_seconds: 20,
          x: 100,
          y: 0,
          width: 1820,
          height: 1080,
          source_start_seconds: 10,
          source_end_seconds: 30,
          time_mode: 'trim'
        }
      ],
      annotations: [
        {
          id: ids[4],
          kind: 'caption',
          language: 'en',
          text: 'Waves at the threshold.',
          start_seconds: 0,
          end_seconds: 10
        }
      ]
    };
    set(record, 'preservation', 'presentation_scenes', [scene]);
    expect(() => validateMuseumDraft(record)).not.toThrow();
    expect(
      museumAssetReferences(record.modules.preservation).map((item) => item.id)
    ).toContain(ids[3]);
    set(record, 'preservation', 'presentation_scenes', [
      { ...scene, resources: [{ ...scene.resources[0], width: 1821 }] }
    ]);
    expect(() => validateMuseumDraft(record)).toThrow(
      'PRESENTATION_REGION_OUT_OF_BOUNDS'
    );
    set(record, 'preservation', 'presentation_scenes', [
      { ...scene, resources: [{ ...scene.resources[0], end_seconds: 21 }] }
    ]);
    expect(() => validateMuseumDraft(record)).toThrow(
      'PRESENTATION_TIME_OUT_OF_BOUNDS'
    );
    set(record, 'preservation', 'presentation_scenes', [
      {
        ...scene,
        resources: [{ ...scene.resources[0], source_end_seconds: 9 }]
      }
    ]);
    expect(() => validateMuseumDraft(record)).toThrow('INVALID_TIME_RANGE');
  });
});
