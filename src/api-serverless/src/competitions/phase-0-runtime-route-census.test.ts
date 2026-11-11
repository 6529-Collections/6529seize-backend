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

const RETIRED_OPERATIONAL_ROUTES = new Set([
  '/deploy/release-bus/controls',
  '/deploy/release-candidates',
  '/deploy/release-trains',
  '/deploy/release-trains/:id',
  '/deploy/ui/branch-head',
  '/deploy/ui/bus',
  '/deploy/ui/bus/app.js',
  '/rpc/test'
]);

const HAND_WRITTEN_ROUTE_SOURCE_LINE_DRIFT = 250;

// The address-only Alchemy migration retains this route as an uncached 410.
// Keep checking its mount/auth and every other baseline cache expectation.
// GET /api/waves/:id shares anonymous responses for 15 s (#2340).
const ACCEPTED_ROUTE_CACHE_CHANGES = new Map<string, ManifestRoute['cache']>([
  ['/alchemy-proxy/collections', 'uncached'],
  ['/api/waves/:id', 'cached']
]);

// Optional authentication keeps anonymous callers working; it lets members
// list followers of waves they can read.
const ACCEPTED_ROUTE_AUTH_CHANGES = new Map<string, ManifestRoute['auth']>([
  ['/api/identity-subscriptions/incoming/:target_type/:target_id', 'optional']
]);

const ACCEPTED_ROUTE_SOURCE_MOVES = new Map<string, string>([
  [
    '/api/policies/eula-consent/:deviceId',
    'src/api-serverless/src/generated/routes/openapi-generated.routes.ts:149'
  ],
  [
    '/api/waves/:id/subwaves',
    'src/api-serverless/src/generated/routes/openapi-generated.routes.ts:938'
  ],
  // requestLogMiddleware, the access-token strategy and then the Sentry alert
  // formatting moved out of app.ts, shifting the hand-written routes up;
  // these now sit nearer the catch-all '' GET than their baseline lines.
  ['/api/nfts/:contract/media', 'src/api-serverless/src/app.ts:851'],
  ['/api/nfts_memelab', 'src/api-serverless/src/app.ts:863'],
  ['/api/memes_extended_data', 'src/api-serverless/src/app.ts:899'],
  ['/api/new_memes_seasons', 'src/api-serverless/src/app.ts:928'],
  ['/api/memes_lite', 'src/api-serverless/src/app.ts:938'],
  ['/api/memelab_lite', 'src/api-serverless/src/app.ts:954'],
  ['/api/memes_latest', 'src/api-serverless/src/app.ts:970'],
  ['/api/nfts_search', 'src/api-serverless/src/app.ts:985'],
  ['/api/lab_extended_data', 'src/api-serverless/src/app.ts:998'],
  ['/api/transactions', 'src/api-serverless/src/app.ts:1016'],
  ['/api/transactions_memelab', 'src/api-serverless/src/app.ts:1039'],
  ['/api/tdh/gradients', 'src/api-serverless/src/app.ts:1062'],
  ['/api/consolidations/:wallet', 'src/api-serverless/src/app.ts:1075'],
  ['/api/consolidations', 'src/api-serverless/src/app.ts:1091'],
  ['/api/nft_history/:contract/:nft_id', 'src/api-serverless/src/app.ts:1108'],
  ['/api/rememes_uploads', 'src/api-serverless/src/app.ts:1129'],
  ['/api/tdh_global_history', 'src/api-serverless/src/app.ts:1146'],
  [
    '/api/recent_tdh_history/:consolidation_key',
    'src/api-serverless/src/app.ts:1165'
  ]
]);

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
    expect(
      manifest.routes.filter(
        (route) => !RETIRED_OPERATIONAL_ROUTES.has(route.path)
      )
    ).toHaveLength(288);
  });

  it('keeps every non-retired route declaration mounted in its owning source', () => {
    const callsBySource = new Map<string, GetCall[]>();
    const failures: string[] = [];
    for (const route of manifest.routes.filter(
      (entry) => !RETIRED_OPERATIONAL_ROUTES.has(entry.path)
    )) {
      const acceptedSource =
        ACCEPTED_ROUTE_SOURCE_MOVES.get(route.path) ?? route.source;
      const separator = acceptedSource.lastIndexOf(':');
      const relativeFile = acceptedSource.slice(0, separator);
      const baselineLine = Number(acceptedSource.slice(separator + 1));
      const sourcePath = path.join(repositoryRoot, relativeFile);
      const generatedRouteSource = relativeFile.endsWith(
        '/generated/routes/openapi-generated.routes.ts'
      );
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
            generatedRouteSource
              ? route.path === `/api${localPath}`
              : localPathMatches(route.path, localPath)
          )
        )
        .sort(
          (left, right) =>
            Math.abs(left.line - baselineLine) -
            Math.abs(right.line - baselineLine)
        );
      const best = matching[0];
      // Generated routes move when unrelated operations are added. Their exact
      // mounted path and uniqueness identify them more reliably than line offsets.
      if (generatedRouteSource && matching.length !== 1) {
        failures.push(
          `${route.path}: expected one exact generated GET declaration`
        );
        continue;
      }
      if (
        !best ||
        (!generatedRouteSource &&
          Math.abs(best.line - baselineLine) >
            HAND_WRITTEN_ROUTE_SOURCE_LINE_DRIFT)
      ) {
        failures.push(
          `${route.path}: GET declaration missing near ${acceptedSource}`
        );
        continue;
      }
      const expectedAuth =
        ACCEPTED_ROUTE_AUTH_CHANGES.get(route.path) ?? route.auth;
      if (best.auth !== 'unknown' && best.auth !== expectedAuth) {
        failures.push(
          `${route.path}: auth changed from ${expectedAuth} to ${best.auth}`
        );
      } else if (
        best.auth === 'unknown' &&
        route.auth !== 'none' &&
        route.operation_id === null
      ) {
        failures.push(`${route.path}: required auth has no static evidence`);
      }
      const expectedCache =
        ACCEPTED_ROUTE_CACHE_CHANGES.get(route.path) ?? route.cache;
      if (best.cache !== expectedCache) {
        failures.push(
          `${route.path}: cache changed from ${expectedCache} to ${best.cache}`
        );
      }
    }
    expect(failures).toEqual([]);
  });
});
