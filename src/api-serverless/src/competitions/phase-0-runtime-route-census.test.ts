import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';

type ManifestRoute = {
  readonly path: string;
  readonly auth: 'none' | 'optional' | 'required';
  readonly cache: 'cached' | 'uncached';
  readonly source: string;
  readonly operation_id: string | null;
};

type GetCall = {
  readonly line: number;
  readonly paths: readonly string[];
  readonly auth: ManifestRoute['auth'] | 'unknown';
  readonly cache: ManifestRoute['cache'] | null;
};

const repositoryRoot = path.resolve(__dirname, '../../../..');
const fixtureRoot = path.resolve(
  __dirname,
  '../../../competitions/contract-fixtures/phase-0'
);

function literalPaths(node: ts.Expression): string[] {
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.flatMap((element) =>
      ts.isExpression(element) ? literalPaths(element) : []
    );
  }
  if (ts.isStringLiteralLike(node)) return [node.text];
  if (ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  return [];
}

function authMode(text: string): ManifestRoute['auth'] | 'unknown' {
  if (text.includes('needsAuthenticatedUser(')) return 'required';
  if (text.includes('maybeAuthenticatedUser(')) return 'optional';
  if (
    /getGitHubTokenOrThrow\(|requireAuthenticatedViewer\(|requireWorkflowCredential\(/.test(
      text
    )
  ) {
    return 'required';
  }
  return 'unknown';
}

function cacheMode(text: string): ManifestRoute['cache'] {
  return /cache|Cache|redisGet/.test(text) ? 'cached' : 'uncached';
}

function getCalls(sourcePath: string): GetCall[] {
  const sourceText = fs.readFileSync(sourcePath, 'utf8');
  const source = ts.createSourceFile(
    sourcePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true
  );
  const calls: GetCall[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'get' &&
      node.arguments[0]
    ) {
      const paths = literalPaths(node.arguments[0]);
      if (paths.length) {
        const text = node.getText(source);
        const middlewareText = node.arguments
          .slice(1, -1)
          .map((argument) => argument.getText(source))
          .join('\n');
        calls.push({
          line:
            source.getLineAndCharacterOfPosition(node.getStart(source)).line +
            1,
          paths,
          auth: authMode(text),
          cache: cacheMode(middlewareText)
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return calls;
}

function localPathMatches(mountedPath: string, localPath: string): boolean {
  if (localPath === '' || localPath === '/') return true;
  const normalized = localPath === '/' ? '/' : localPath.replace(/\/$/, '');
  return (
    mountedPath === normalized ||
    mountedPath.endsWith(normalized) ||
    (normalized === '/' && mountedPath.endsWith('/'))
  );
}

describe('Phase 0 permanent mounted GET route census', () => {
  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(fixtureRoot, 'runtime-get-route-manifest.json'),
      'utf8'
    )
  ) as {
    baseline: { counts: Record<string, number> };
    routes: ManifestRoute[];
  };

  it('keeps the accepted manifest internally complete and unique', () => {
    expect(manifest.routes).toHaveLength(296);
    expect(manifest.baseline.counts.runtime_route_shapes).toBe(296);
    expect(manifest.baseline.counts.openapi_get_operations).toBe(183);
    expect(new Set(manifest.routes.map((route) => route.path)).size).toBe(296);
  });

  it('keeps every accepted route declaration mounted in its owning source', () => {
    const callsBySource = new Map<string, GetCall[]>();
    const failures: string[] = [];
    for (const route of manifest.routes) {
      const separator = route.source.lastIndexOf(':');
      const relativeFile = route.source.slice(0, separator);
      const baselineLine = Number(route.source.slice(separator + 1));
      const sourcePath = path.join(repositoryRoot, relativeFile);
      if (!fs.existsSync(sourcePath)) {
        failures.push(`${route.path}: missing ${relativeFile}`);
        continue;
      }
      const calls =
        callsBySource.get(sourcePath) ??
        (() => {
          const parsed = getCalls(sourcePath);
          callsBySource.set(sourcePath, parsed);
          return parsed;
        })();
      const matching = calls
        .filter((call) =>
          call.paths.some((localPath) =>
            localPathMatches(route.path, localPath)
          )
        )
        .sort(
          (left, right) =>
            Math.abs(left.line - baselineLine) -
            Math.abs(right.line - baselineLine)
        );
      const best = matching[0];
      if (!best || Math.abs(best.line - baselineLine) > 250) {
        failures.push(
          `${route.path}: GET declaration missing near ${route.source}`
        );
        continue;
      }
      if (best.auth !== 'unknown' && best.auth !== route.auth) {
        failures.push(
          `${route.path}: auth changed from ${route.auth} to ${best.auth}`
        );
      } else if (
        best.auth === 'unknown' &&
        route.auth !== 'none' &&
        route.operation_id === null
      ) {
        failures.push(`${route.path}: required auth has no static evidence`);
      }
      if (best.cache !== route.cache) {
        failures.push(
          `${route.path}: cache changed from ${route.cache} to ${best.cache}`
        );
      }
    }
    expect(failures).toEqual([]);
  });
});
