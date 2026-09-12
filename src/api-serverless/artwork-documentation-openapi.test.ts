import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import type { ApiArtworkDocumentationAsset } from '@/api/generated/models/ApiArtworkDocumentationAsset';

type Schema = {
  type?: string;
  pattern?: string;
};

type OpenApiDocument = {
  paths: Record<
    string,
    {
      post: {
        parameters: {
          name: string;
          in: string;
          required: boolean;
          schema: Schema;
        }[];
      };
    }
  >;
};

const openapi = parse(
  readFileSync(resolve(__dirname, 'openapi.yaml'), 'utf8')
) as OpenApiDocument;

describe('artwork documentation OpenAPI response and concurrency contract', () => {
  it('allows the generated response type to represent deferred metadata', () => {
    const asset: Pick<ApiArtworkDocumentationAsset, 'technical_metadata'> = {
      technical_metadata: null
    };
    expect(asset.technical_metadata).toBeNull();
  });

  it.each(['museum-records', 'dossier/exports'])(
    'requires a quoted positive draft version for %s writes',
    (suffix) => {
      const header = openapi.paths[
        `/artwork-documentation/contexts/{id}/${suffix}`
      ].post.parameters.find((parameter) => parameter.name === 'If-Match');
      expect(header).toMatchObject({
        in: 'header',
        required: true,
        schema: { type: 'string', pattern: '^"draft-[1-9][0-9]*"$' }
      });
      if (!header?.schema.pattern) throw new Error('Missing draft pattern');
      const pattern = new RegExp(header.schema.pattern);
      for (const value of ['"draft-1"', '"draft-123"']) {
        expect(pattern.test(value)).toBe(true);
      }
      for (const value of [
        'draft-1',
        '"draft-0"',
        '"draft-01"',
        '"draft--1"',
        '"draft-1.5"',
        '*'
      ]) {
        expect(pattern.test(value)).toBe(false);
      }
    }
  );
});
