import { emptyModules, getProfile } from '../artwork-documentation.catalogue';
import { ContextRecord } from '../artwork-documentation.types';
import {
  museumEvidenceIds,
  validateMuseumRecord
} from './museum-record.validation';

const workId = '10000000-0000-4000-8000-000000000001';
const assetId = '10000000-0000-4000-8000-000000000002';
const context = JSON.parse(
  JSON.stringify({
    id: workId,
    work_id: workId,
    profile: getProfile('stream_artwork_basic_v1', 3),
    modules: emptyModules(),
    asset_links: [],
    restricted_paths: []
  })
) as ContextRecord;
const note = () => ({
  kind: 'catalogue_note',
  title: 'Authored research',
  event_status: 'completed',
  subject_ids: [workId],
  evidence_asset_ids: [],
  details: {
    source: 'The artist’s dated account',
    conclusion: 'The print dimensions refer to the image area.'
  }
});

describe('Attributed museum record validation', () => {
  it('accepts an attributed note with a known subject and preserves its account', () => {
    expect(validateMuseumRecord(note(), context).details.conclusion).toContain(
      'image area'
    );
  });
  it('rejects unknown fields, unknown subjects and duplicate evidence', () => {
    expect(() =>
      validateMuseumRecord({ ...note(), verified: true }, context)
    ).toThrow();
    expect(() =>
      validateMuseumRecord({ ...note(), subject_ids: [assetId] }, context)
    ).toThrow();
    expect(() =>
      validateMuseumRecord(
        { ...note(), evidence_asset_ids: [assetId, assetId] },
        context
      )
    ).toThrow();
  });
  it('requires evidence for a reported verification outcome', () => {
    const condition = {
      ...note(),
      kind: 'condition',
      details: {
        examiner: 'Examiner',
        method: 'Compared the original bytes',
        outcome: 'A match',
        finality_check: 'not_available',
        fixity_check: 'verified',
        rendering_check: 'not_verified',
        recovery_lineage: 'No recovery event applies.'
      }
    };
    expect(() => validateMuseumRecord(condition, context)).toThrow();
    expect(
      museumEvidenceIds(
        validateMuseumRecord(
          {
            ...condition,
            details: { ...condition.details, verification_asset_id: assetId }
          },
          context
        )
      )
    ).toEqual([assetId]);
  });
  it('keeps a Getty concept distinct from its real-world place focus', () => {
    const alignment = {
      ...note(),
      kind: 'authority_alignment',
      details: {
        entity_id: workId,
        authority: 'GETTY_TGN',
        identifier: '1234',
        canonical_iri: 'http://vocab.getty.edu/tgn/1234',
        focus_iri: 'http://vocab.getty.edu/tgn/1234-place',
        match_kind: 'related_reference',
        review_status: 'unreviewed',
        observed_label: 'A place',
        retrieved_date: '2026-09-12',
        snapshot_asset_id: assetId,
        basis: 'Comparison needs review'
      }
    };
    expect(
      validateMuseumRecord(alignment, context).details.focus_iri
    ).toContain('-place');
    expect(() =>
      validateMuseumRecord(
        { ...alignment, details: { ...alignment.details, identifier: '9999' } },
        context
      )
    ).toThrow();
    expect(() =>
      validateMuseumRecord(
        {
          ...alignment,
          details: {
            ...alignment.details,
            focus_iri: 'https://unrelated.example/place'
          }
        },
        context
      )
    ).toThrow();
  });
});
