import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';

/** New call sites for source writers require an explicit coverage review. */
const writerCallSites: Record<string, readonly string[]> = {
  bulkCreateIdentities: [
    'src/profiles/profiles.service.ts',
    'src/xtdh/recalculate-xtdh.use-case.ts'
  ],
  bulkInsertIdentities: [
    'src/api-serverless/src/identities/identities.service.ts',
    'src/identity.ts'
  ],
  migrateGrantorId: ['src/profiles/profiles.service.ts'],
  migrateProfileIdsInGroups: ['src/profiles/profiles.service.ts'],
  persistConsolidatedTDH: ['src/tdhLoop/tdh_consolidation.ts'],
  persistConsolidations: ['src/delegationsLoop/index.ts'],
  persistNftOwners: ['src/nftOwnersLoop/nft_owners.ts'],
  persistTDH: ['src/tdhLoop/tdh.ts'],
  syncIdentitiesMetrics: ['src/db.ts'],
  updatePrimaryAddresses: ['src/delegationsLoop/index.ts'],
  upsertOwners: [
    'src/external-indexing/external-collection-live-tailing.service.ts',
    'src/external-indexing/external-collection-snapshotting.service.ts'
  ]
};

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts'))
      return [];
    return [full];
  });
}

function callName(node: ts.CallExpression): string | null {
  if (ts.isIdentifier(node.expression)) return node.expression.text;
  if (ts.isPropertyAccessExpression(node.expression))
    return node.expression.name.text;
  return null;
}

describe('Membership producer writer inventory', () => {
  it('requires review when a guarded writer gains a new call site', () => {
    const actual = new Map<string, Set<string>>();
    for (const file of sourceFiles(path.resolve('src'))) {
      const relative = path.relative(process.cwd(), file).replace(/\\/g, '/');
      const source = ts.createSourceFile(
        file,
        fs.readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true
      );
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const name = callName(node);
          if (name && name in writerCallSites) {
            const sites = actual.get(name) ?? new Set<string>();
            sites.add(relative);
            actual.set(name, sites);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    for (const [name, expected] of Object.entries(writerCallSites))
      expect(Array.from(actual.get(name) ?? []).sort()).toEqual(
        [...expected].sort()
      );
  });

  it('marks both shared identity callers and the delegation caller with their owning barrier', () => {
    const read = (file: string) => fs.readFileSync(path.resolve(file), 'utf8');
    expect(read('src/profiles/profiles.service.ts')).toMatch(
      /bulkCreateIdentities\([\s\S]*?'profile-creation'/
    );
    expect(read('src/xtdh/recalculate-xtdh.use-case.ts')).toMatch(
      /bulkCreateIdentities\([\s\S]*?'xtdh-universe'/
    );
    expect(read('src/delegationsLoop/index.ts')).toContain(
      "updatePrimaryAddresses(wallets, 'delegations-cycle')"
    );
  });
});
