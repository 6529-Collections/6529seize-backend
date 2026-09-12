import { buildPremis } from './premis';
import { dossierFixture } from './dossier-fixture';
import { Answer, Json } from '../../artwork-documentation.types';

const provided = (value: Json): Answer => ({
  status: 'provided',
  value,
  intended_visibility: 'public_record'
});
const sections = (xml: string, name: string) =>
  xml
    .split(`<premis:${name}>`)
    .slice(1)
    .map((part) => part.split(`</premis:${name}>`)[0]);
const id = (n: number) =>
  `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('PREMIS preservation record', () => {
  it('retains intellectual work without files and escapes original artist language', () => {
    const { snapshot } = dossierFixture();
    snapshot.assets = [];
    snapshot.context.asset_links = [];
    const xml = buildPremis(snapshot);
    expect(xml).toContain('xsi:type="premis:intellectualEntity"');
    expect(xml).toContain('A test &amp; a record');
    expect(xml).not.toContain('xsi:type="premis:file"');
    expect(xml).not.toContain('private-test-bucket');
  });
  it('separates original file fixity, format measurement, safety scan and C2PA trust limitations', () => {
    const { snapshot } = dossierFixture();
    const metadata = JSON.parse(snapshot.assets[0].technical_metadata_json!);
    metadata.c2pa = {
      status: 'report_available',
      original_bytes_preserved: true,
      validator: '@contentauth/c2pa-node',
      validator_version: '0.9.5',
      integrity: 'valid',
      trust: 'not_assessed',
      remote_fetch: false
    };
    snapshot.assets[0].technical_metadata_json = JSON.stringify(metadata);
    const xml = buildPremis(snapshot);
    const events = sections(xml, 'event');
    expect(events).toHaveLength(4);
    expect(events.find((item) => item.includes('virus check'))).toContain(
      '<premis:eventDateTime>unknown</premis:eventDateTime>'
    );
    expect(
      events.find((item) => item.includes('format identification'))
    ).toContain('2026-09-12T12:00:00Z');
    expect(events.find((item) => item.includes('C2PA validation'))).toContain(
      'signer trust not assessed'
    );
    expect(xml).toContain(snapshot.assets[0].sha256);
    expect(xml).toContain('<premis:agentType>software</premis:agentType>');
    expect(xml).not.toContain(
      '<premis:eventType>FIXITY_CHECK</premis:eventType>'
    );
  });
  it('exports completed preservation work with typed object roles, retaining plans only as source statements', () => {
    const { snapshot } = dossierFixture();
    const base = {
      context_id: snapshot.context.id,
      actor_profile_id: 'technical-curator',
      kind: 'preservation',
      source_draft_version: 1,
      created_at: 10000
    };
    const payload = {
      title: 'Migration',
      event_status: 'completed',
      subject_ids: [snapshot.context.work_id],
      evidence_asset_ids: [],
      details: {
        event_type: 'MIGRATION',
        agent: 'Conservator or tool as recorded',
        method: 'Preserve source and compare result.',
        outcome: 'Completed',
        input_asset_ids: [snapshot.assets[0].id],
        output_asset_ids: []
      }
    };
    snapshot.museum_records = [
      { ...base, id: id(1), payload_json: JSON.stringify(payload) },
      {
        ...base,
        id: id(2),
        payload_json: JSON.stringify({ ...payload, event_status: 'planned' })
      }
    ];
    const events = sections(buildPremis(snapshot), 'event').filter((item) =>
      item.includes('<premis:eventType>MIGRATION</premis:eventType>')
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toContain(
      '<premis:linkingObjectRole>source</premis:linkingObjectRole>'
    );
    expect(events[0]).toContain(
      '<premis:linkingAgentRole>recorder</premis:linkingAgentRole>'
    );
    expect(events[0]).toContain(
      '<premis:eventDateTime>unknown</premis:eventDateTime>'
    );
    expect(buildPremis(snapshot)).toContain('planned');
  });
  it('keeps per-file permissions scoped and never turns denied, unspecified or program intentions into grants', () => {
    const { snapshot } = dossierFixture();
    snapshot.context.modules.rights.material_rights = provided([
      {
        id: id(3),
        subject_ids: [snapshot.assets[0].id],
        basis: 'license',
        license_uri: 'https://example.org/license',
        licensor: 'Interview participant',
        account: 'The interview may be published with credit.',
        uses: [
          {
            use: 'publication',
            status: 'granted_with_conditions',
            conditions: 'Credit the speaker.'
          },
          { use: 'ai_training', status: 'denied' },
          { use: 'derivative', status: 'unspecified' }
        ]
      }
    ]);
    const xml = buildPremis(snapshot);
    const grants = sections(xml, 'rightsGranted');
    expect(grants).toHaveLength(1);
    expect(grants[0]).toContain('<premis:act>publication</premis:act>');
    expect(grants[0]).toContain('Credit the speaker.');
    const right = sections(xml, 'rightsStatement').find((item) =>
      item.includes(`urn:uuid:${id(3)}`)
    )!;
    expect(right).toContain(
      `<premis:linkingObjectIdentifierValue>urn:uuid:${snapshot.assets[0].id}</premis:linkingObjectIdentifierValue>`
    );
    expect(right).not.toContain(
      `<premis:linkingObjectIdentifierValue>urn:uuid:${snapshot.context.work_id}</premis:linkingObjectIdentifierValue>`
    );
    expect(right).toContain('ai_training');
    expect(right).toContain('denied');
  });
});
