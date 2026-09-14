import { createHash } from 'node:crypto';
import {
  emptyModules,
  getProfile
} from '../../artwork-documentation.catalogue';
import { Answer, ContextRecord, Json } from '../../artwork-documentation.types';
import { StoredAsset } from '../../assets/artwork-assets.types';
import { DossierSnapshot } from './dossier.types';

/** Synthetic, explicitly attributed test data; never an artist example or a receipt. */
export function dossierFixture(): {
  snapshot: DossierSnapshot;
  original: Buffer;
} {
  const original = Buffer.from(
    'Synthetic original bytes for package verification.\n'
  );
  const id = (n: number) =>
    `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const provided = (value: Json): Answer => ({
    status: 'provided',
    value,
    intended_visibility: 'public_record'
  });
  const asset = {
    id: id(3),
    context_id: id(1),
    uploader_profile_id: 'test-artist',
    filename: 'Test <file>.png',
    extension: 'png',
    role: 'artwork_final',
    access_class: 'artwork',
    intended_visibility: 'public_record',
    state: 'ready',
    size_bytes: original.length,
    bucket: 'private-test-bucket',
    object_key: 'originals/test',
    object_version: '1',
    sha256: createHash('sha256').update(original).digest('hex'),
    detected_mime: 'image/png',
    width: 10,
    height: 20,
    scan_status: 'NO_THREATS_FOUND',
    inspection_status: 'verified',
    created_at: 1000,
    updated_at: 1000,
    technical_metadata_json: JSON.stringify({
      version: 1,
      characterization: 'partial',
      method: 'test fixture',
      detected_format: 'PNG',
      format_registry: {
        status: 'unidentified',
        authority: null,
        identifier: null
      },
      original_sha256: createHash('sha256').update(original).digest('hex'),
      measured_at: '2026-09-12T12:00:00Z',
      properties: {},
      warnings: [],
      c2pa: { status: 'not_validated', original_bytes_preserved: true }
    })
  } as StoredAsset;
  const modules = emptyModules();
  modules.artwork.title = provided('A test & a record');
  modules.artwork.media_profiles = provided(['photography']);
  modules.artwork.physical_objects = provided([
    {
      id: id(4),
      kind: 'print',
      name: 'Studio proof',
      materials: 'Pigment on paper',
      status: 'described'
    }
  ]);
  modules.context.documents = provided([
    {
      id: id(5),
      kind: 'artist_statement',
      title: 'Statement',
      language: 'en',
      text: 'The image contains <a gate> & water.\nA second paragraph.',
      authors: [{ agent_id: id(6), role: 'artist' }],
      authorship: 'original',
      review_status: 'author_reviewed'
    }
  ]);
  modules.identity.agents = provided([
    { id: id(6), kind: 'person', name: 'Test Artist' }
  ]);
  modules.context.events = provided([
    {
      id: id(7),
      kind: 'creation',
      title: 'Image creation',
      date: { precision: 'day', start: '2026-09-12', approximate: false },
      subject_ids: [id(2)],
      participants: [{ agent_id: id(6), role: 'artist' }],
      account: 'Recorded by the test artist.'
    }
  ]);
  const context = {
    id: id(1),
    work_id: id(2),
    owner_profile_id: 'test-artist',
    program_id: null,
    profile: getProfile('stream_artwork_basic_v1', 3),
    draft_version: 1,
    artist_record_revision_id: null,
    latest_revision_id: null,
    lifecycle: 'active',
    modules,
    restricted_paths: [],
    asset_links: [
      {
        id: id(8),
        asset_id: asset.id,
        role: 'artwork_final',
        label: 'Original',
        description: '',
        intended_visibility: 'public_record',
        source_of_asset: 'Artist',
        source_credit: 'Test Artist',
        derived_from_asset_ids: [],
        deposit_note: '',
        intended_terms: { kind: 'public_domain' },
        manifest: { id: asset.id, sha256: asset.sha256 }
      }
    ],
    created_at: Date.UTC(2026, 8, 12),
    updated_at: Date.UTC(2026, 8, 12)
  } as ContextRecord;
  const snapshot = JSON.parse(
    JSON.stringify({
      context,
      assets: [asset],
      museum_records: [],
      source_receipts: [],
      confirmed_revision: null,
      confirmation: 'unconfirmed'
    })
  ) as DossierSnapshot;
  return { snapshot, original };
}
