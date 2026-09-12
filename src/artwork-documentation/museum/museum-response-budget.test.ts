import { documentationContextBytes } from './museum-response-budget';
import { dossierFixture } from './export/dossier-fixture';

describe('Museum response budget', () => {
  it('includes linked file snapshots and the escaped Lambda response, not just answers', () => {
    const { snapshot } = dossierFixture();
    const context = snapshot.context;
    const before = documentationContextBytes(context);
    context.asset_links[0].description = '\\"'.repeat(1000);
    const after = documentationContextBytes(context);
    expect(after - before).toBeGreaterThan(4000);
    expect(after).toBeGreaterThan(
      Buffer.byteLength(JSON.stringify(context.modules), 'utf8')
    );
  });
  it('preserves the original v1/v2 budget semantics', () => {
    const { snapshot } = dossierFixture();
    snapshot.context.profile.version = 2;
    expect(documentationContextBytes(snapshot.context)).toBe(
      Buffer.byteLength(JSON.stringify(snapshot.context.modules), 'utf8')
    );
  });
});
