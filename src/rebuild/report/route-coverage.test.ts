import * as path from 'node:path';
import {
  documentedGetRoutes,
  readDocumentedRoutes,
  routeCoverage
} from '@/rebuild/report/route-coverage';

const YAML = `openapi: 3.0.0
servers:
  - url: /api
paths:
  /profiles/{identity}:
    get:
      operationId: getProfile
    post:
      operationId: updateProfile
  /tdh/total:
    get:
      operationId: total
  /waves:
    post:
      operationId: createWave
`;

describe('route coverage', () => {
  it('reads GET routes with the server prefix', () => {
    expect(documentedGetRoutes(YAML)).toEqual([
      'GET /api/profiles/{identity}',
      'GET /api/tdh/total'
    ]);
  });

  it('reads both of the API files', () => {
    const routes = readDocumentedRoutes(
      path.resolve(__dirname, '..', '..', '..')
    );
    expect(routes.length).toBeGreaterThan(300);
    expect(routes.some((r) => r.startsWith('GET /oracle/'))).toBe(true);
    expect(new Set(routes).size).toBe(routes.length);
  });

  it('matches filled-in probe paths and waivers to routes', () => {
    const coverage = routeCoverage(
      ['GET /api/profiles/{identity}', 'GET /api/tdh/total', 'GET /api/waves'],
      [
        { method: 'GET', path: '/api/profiles/fixture01?x=1' },
        { method: 'POST', path: '/api/waves' }
      ],
      ['GET /api/tdh/{}']
    );
    expect(coverage).toEqual({
      probed: ['GET /api/profiles/{identity}'],
      waived: [],
      open: ['GET /api/tdh/total', 'GET /api/waves']
    });
    expect(
      routeCoverage(['GET /api/tdh/total'], [], ['GET /api/tdh/total']).waived
    ).toEqual(['GET /api/tdh/total']);
  });

  it('does not let a placeholder cross a slash', () => {
    expect(
      routeCoverage(
        ['GET /api/profiles/{identity}'],
        [{ method: 'GET', path: '/api/profiles/a/b' }],
        []
      ).open
    ).toEqual(['GET /api/profiles/{identity}']);
  });
});
