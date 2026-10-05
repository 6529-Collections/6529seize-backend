import * as fs from 'node:fs';
import * as path from 'node:path';
import { ObjectSerializer } from '@/api/generated/models/ObjectSerializer';

const yaml = require('js-yaml') as {
  load(value: string): unknown;
};

type OpenApiOperation = Record<string, any>;
type OpenApiDocument = {
  readonly paths: Record<string, { readonly get?: OpenApiOperation }>;
};

const openapi = yaml.load(
  fs.readFileSync(path.resolve(__dirname, '../../openapi.yaml'), 'utf8')
) as OpenApiDocument;

describe('competition v3 OpenAPI contract', () => {
  const operations = Object.entries(openapi.paths)
    .filter(
      ([route, pathItem]) => route.startsWith('/v3/waves') && pathItem.get
    )
    .map(([route, pathItem]) => ({ route, operation: pathItem.get! }));

  it('documents validation and masking responses for every read', () => {
    // Default navigation adds one read to the twenty native/foundation reads.
    // Write-only paths are deliberately excluded, while every GET retains the
    // validation and masked-not-found response guarantees.
    expect(operations).toHaveLength(21);
    for (const { route, operation } of operations) {
      expect({ route, responses: operation.responses }).toMatchObject({
        route,
        responses: { '400': expect.any(Object), '404': expect.any(Object) }
      });
    }
  });

  it('keeps default selection optional-auth and uncached, including nullable serialization', () => {
    const operation =
      openapi.paths['/v3/waves/{wave_id}/default-competition'].get!;
    expect(operation['x-6529-router']).toMatchObject({
      auth: 'optional',
      cache: false
    });
    const result = {
      competition_id: null,
      evaluated_at: 100,
      next_refresh_at: null
    };
    expect(
      ObjectSerializer.serialize(result, 'ApiDefaultCompetition', '')
    ).toEqual(result);
  });

  it('uses one direction type with operation-specific defaults', () => {
    const descOperations = new Set([
      'listCompetitionLeaderboardV3',
      'listCompetitionVotersV3'
    ]);
    const operationsWithDirection = operations.filter(({ operation }) =>
      operation.parameters?.some(
        (parameter: Record<string, unknown>) => parameter.name === 'direction'
      )
    );

    expect(operationsWithDirection).toHaveLength(10);
    for (const { operation } of operationsWithDirection) {
      const direction = operation.parameters.find(
        (parameter: Record<string, unknown>) => parameter.name === 'direction'
      );
      expect(direction.schema.allOf).toEqual([
        { $ref: '#/components/schemas/ApiCompetitionSortDirection' }
      ]);
      expect(direction.schema.default).toBe(
        descOperations.has(operation.operationId) ? 'DESC' : 'ASC'
      );
    }
  });
});
