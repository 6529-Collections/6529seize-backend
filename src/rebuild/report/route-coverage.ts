import * as fs from 'node:fs';
import * as path from 'node:path';

/** A GET route the API documents, as `GET /api/profiles/{identity}`. */
export type DocumentedRoute = string;

export interface RouteCoverage {
  readonly probed: DocumentedRoute[];
  readonly waived: DocumentedRoute[];
  /** Documented GET routes no probe calls and no waiver names. */
  readonly open: DocumentedRoute[];
}

const PATH_LINE = /^ {2}(\/[^:\s]*):\s*$/;
const GET_LINE = /^ {4}get:\s*$/;
const SERVER_LINE = /^\s+- url:\s*['"]?(\/[^'"\s]*)['"]?\s*$/;

/**
 * The GET routes of an OpenAPI file, with its server prefix. Reads the
 * layout this repo's files use: paths at two spaces, methods at four.
 */
export function documentedGetRoutes(yaml: string): DocumentedRoute[] {
  const routes: DocumentedRoute[] = [];
  let prefix = '';
  let current: string | null = null;
  for (const line of yaml.split(/\r?\n/)) {
    const server = SERVER_LINE.exec(line);
    if (server && !prefix) prefix = server[1].replace(/\/$/, '');
    const pathMatch = PATH_LINE.exec(line);
    if (pathMatch) {
      current = pathMatch[1];
      continue;
    }
    if (current && GET_LINE.test(line)) routes.push(`GET ${prefix}${current}`);
  }
  return routes;
}

/** Both of the API's OpenAPI files. */
export function readDocumentedRoutes(repoRoot: string): DocumentedRoute[] {
  const directory = path.join(repoRoot, 'src', 'api-serverless');
  return ['openapi.yaml', 'openapi.oracle.yaml'].flatMap((file) =>
    documentedGetRoutes(fs.readFileSync(path.join(directory, file), 'utf8'))
  );
}

function routePattern(route: DocumentedRoute): RegExp {
  const template = route.replace(/^GET /, '');
  const escaped = template
    .split(/\{[^}]+\}/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]+');
  return new RegExp(`^${escaped}/?$`);
}

function sameTemplate(a: string, b: string): boolean {
  const bare = (route: string) =>
    route.replace(/^GET\s+/, '').replace(/\{[^}]+\}/g, '{}');
  return bare(a) === bare(b);
}

/**
 * Which documented routes the probes call (by their filled-in paths), which
 * a waiver names, and which are open.
 */
export function routeCoverage(
  routes: readonly DocumentedRoute[],
  probeCalls: readonly { method: string; path: string }[],
  waivers: readonly string[]
): RouteCoverage {
  const called = probeCalls
    .filter((call) => call.method === 'GET')
    .map((call) => call.path.split('?')[0]);
  const probed: DocumentedRoute[] = [];
  const waived: DocumentedRoute[] = [];
  const open: DocumentedRoute[] = [];
  for (const route of routes) {
    const pattern = routePattern(route);
    if (called.some((callPath) => pattern.test(callPath))) probed.push(route);
    else if (waivers.some((waiver) => sameTemplate(waiver, route))) {
      waived.push(route);
    } else open.push(route);
  }
  return { probed, waived, open };
}
