import { ApiMuseumIiifManifest } from '@/api/generated/models/ApiMuseumIiifManifest';
import * as Operations from '@/api/generated/routes/operations';
import { artworkPublicationService } from '@/artwork-documentation/museum/publication/publication.service';
import { PUBLICATION_CONTENT_TYPE } from '@/artwork-documentation/museum/publication/publication.storage';

/**
 * Public IIIF manifest read. This route lives outside the credential-restricted
 * `/api/artwork-documentation` CORS prefix on purpose: IIIF viewers on any
 * origin fetch manifests anonymously. Only JSON is served from this origin;
 * media URLs inside the manifest point at the publisher's bound public hosts.
 */
export async function handleGetMuseumIiifManifest(
  req: Operations.GetMuseumIiifManifestRequest
): Promise<Operations.GetMuseumIiifManifestResponse> {
  const manifest = await artworkPublicationService.publicManifest(
    req.params.publicationId
  );
  req.res?.set({
    'Content-Type': PUBLICATION_CONTENT_TYPE,
    'Cache-Control': 'public, max-age=300',
    'X-Content-Type-Options': 'nosniff'
  });
  return manifest as unknown as ApiMuseumIiifManifest;
}
