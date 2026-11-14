import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { CustomApiCompliantException, NotFoundException } from '@/exceptions';
import { corsOptions, getCorsOptionsForRequest } from '@/api/api-constants';

const mockPublicManifest = jest.fn();
jest.mock(
  '@/artwork-documentation/museum/publication/publication.service',
  () => ({
    artworkPublicationService: { publicManifest: mockPublicManifest },
    PUBLIC_MANIFEST_PATH: (id: string) => `/api/museum/iiif/${id}/manifest`
  })
);

import { handleGetMuseumIiifManifest } from './museum-publication.handlers';

describe('public museum IIIF manifest route', () => {
  const publicationId = randomUUID();
  const manifest = {
    '@context': 'http://iiif.io/api/presentation/3/context.json',
    id: 'https://6529.io/iiif/objects/x/manifest',
    type: 'Manifest',
    label: { none: ['x'] },
    items: []
  };
  const request = () =>
    ({
      params: { publicationId },
      res: { set: jest.fn() }
    }) as unknown as Parameters<typeof handleGetMuseumIiifManifest>[0];

  beforeEach(() => jest.clearAllMocks());

  it('serves the stored manifest as IIIF JSON-LD with public caching', async () => {
    mockPublicManifest.mockResolvedValue(manifest);
    const req = request();
    await expect(handleGetMuseumIiifManifest(req)).resolves.toBe(manifest);
    expect(mockPublicManifest).toHaveBeenCalledWith(publicationId);
    expect(req.res?.set).toHaveBeenCalledWith({
      'Content-Type':
        'application/ld+json;profile="http://iiif.io/api/presentation/3/context.json"',
      'Cache-Control': 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff'
    });
  });

  it.each([
    [new NotFoundException('Publication not found'), 404],
    [
      new CustomApiCompliantException(
        410,
        'Publication withdrawn',
        'PUBLICATION_WITHDRAWN'
      ),
      410
    ]
  ])('propagates %s as status %i', async (error, status) => {
    mockPublicManifest.mockRejectedValue(error);
    const req = request();
    await expect(handleGetMuseumIiifManifest(req)).rejects.toBe(error);
    expect((error as NotFoundException).getStatusCode()).toBe(status);
    expect(req.res?.set).not.toHaveBeenCalled();
  });

  it('lives outside the credential-restricted artwork CORS prefix so wildcard CORS applies', () => {
    const path = `/api/museum/iiif/${publicationId}/manifest`;
    expect(path.startsWith('/api/artwork-documentation')).toBe(false);
    const options = getCorsOptionsForRequest(
      path,
      'https://viewer.example',
      'api.6529.io'
    );
    expect(options).toEqual(corsOptions);
    expect(options.origin).toBe('*');
    expect(options).not.toHaveProperty('credentials');
    const restricted = getCorsOptionsForRequest(
      `/api/artwork-documentation/contexts/${randomUUID()}/publications`,
      'https://viewer.example',
      'api.6529.io'
    );
    expect(restricted.origin).toBe(false);
  });

  it('is declared public and cacheable in the OpenAPI router block', () => {
    const document = yaml.load(
      readFileSync(join(__dirname, '..', '..', 'openapi.yaml'), 'utf8')
    ) as {
      paths: Record<
        string,
        {
          get?: {
            security?: unknown;
            'x-6529-router'?: Record<string, unknown>;
          };
        }
      >;
    };
    const route = document.paths['/museum/iiif/{publicationId}/manifest'].get!;
    expect(route.security).toEqual([]);
    expect(route['x-6529-router']).toMatchObject({
      enabled: true,
      auth: 'none',
      cache: true
    });
    for (const path of Object.keys(document.paths))
      if (path.includes('/publications'))
        expect(path.startsWith('/artwork-documentation/')).toBe(true);
  });
});
