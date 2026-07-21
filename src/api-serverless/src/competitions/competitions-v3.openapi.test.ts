import * as fs from 'node:fs';
import * as path from 'node:path';

const yaml = require('js-yaml') as {
  load(value: string): unknown;
};

type OpenApiOperation = Record<string, any>;
type OpenApiDocument = {
  readonly paths: Record<string, { readonly get: OpenApiOperation }>;
};

const openapi = yaml.load(
  fs.readFileSync(path.resolve(__dirname, '../../openapi.yaml'), 'utf8')
) as OpenApiDocument;

describe('competition v3 OpenAPI contract', () => {
  const operations = Object.entries(openapi.paths)
    .filter(([route]) => route.startsWith('/v3/waves'))
    .map(([route, pathItem]) => ({ route, operation: pathItem.get }));

  it('documents validation and masking responses for every read', () => {
    expect(operations).toHaveLength(14);
    for (const { route, operation } of operations) {
      expect({ route, responses: operation.responses }).toMatchObject({
        route,
        responses: { '400': expect.any(Object), '404': expect.any(Object) }
      });
    }
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
