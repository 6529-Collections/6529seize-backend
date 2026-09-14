import { dossierAssetIds, publicationHistory } from './dossier-history';
import { dossierFixture } from './dossier-fixture';
import { digest } from '../../artwork-documentation.validation';
import { DossierIssue } from './dossier.types';

describe('Portable confirmation and evidence history', () => {
  it('retains public confirmations, reviewer decisions and removed evidence without promoting private legacy content', () => {
    const { snapshot } = dossierFixture();
    const source = {
      asset_links: [
        { asset_id: 'past-original', intended_visibility: 'public_record' }
      ],
      modules: { statement: 'Original artist writing' }
    };
    const publicRevision = {
      id: 'past',
      snapshot_json: JSON.stringify(source),
      sha256: digest(source),
      confirmation_json: '{}',
      source_draft_version: 1
    };
    const privateRevision = {
      id: 'private',
      snapshot_json: JSON.stringify({
        asset_id: 'private-original',
        intended_visibility: 'restricted'
      }),
      sha256: 'old-hash',
      confirmation_json: '{}'
    };
    snapshot.artist_revisions = [publicRevision, privateRevision];
    snapshot.review_history = [
      {
        revision_id: 'past',
        reason: 'Reviewed',
        decision_history_json: '[{"status":"accepted"}]'
      },
      {
        revision_id: 'private',
        reason: 'PRIVATE REVIEW',
        decision_history_json: '[]'
      }
    ];
    snapshot.museum_records = [
      {
        payload_json: JSON.stringify({
          evidence: [{ asset_id: 'journal-original', sha256: 'measured' }]
        })
      }
    ];
    const ids = dossierAssetIds(
      snapshot.context,
      snapshot.artist_revisions,
      snapshot.museum_records
    );
    expect(ids.has('past-original')).toBe(true);
    expect(ids.has('journal-original')).toBe(true);
    expect(ids.has('private-original')).toBe(false);
    const issues: DossierIssue[] = [];
    const history = publicationHistory(snapshot, issues);
    expect(history.artist_revisions[0]).toMatchObject({
      content_included: true,
      snapshot_json: source
    });
    expect(history.artist_revisions[1]).toMatchObject({
      content_included: false,
      sha256: 'old-hash'
    });
    expect(JSON.stringify(history)).not.toContain('PRIVATE REVIEW');
    expect(history.review_history[0]).toMatchObject({
      decision_history_json: [{ status: 'accepted' }]
    });
    expect(issues).toHaveLength(1);
  });
  it('rejects a public confirmed snapshot whose source hash no longer matches', () => {
    const { snapshot } = dossierFixture();
    snapshot.artist_revisions = [
      {
        snapshot_json: '{"changed":true}',
        sha256: digest({ changed: false }),
        confirmation_json: '{}'
      }
    ];
    expect(() => publicationHistory(snapshot, [])).toThrow('digest mismatch');
  });
});
