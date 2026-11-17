import * as Operations from '@/api/generated/routes/operations';
import { artworkPublicationService } from '@/artwork-documentation/museum/publication/publication.service';
import { execute, mutation } from './artwork-documentation.handlers';

export function handleListArtworkPublications(
  req: Operations.ArtworkDocumentationListArtworkPublicationsRequest
): Promise<Operations.ArtworkDocumentationListArtworkPublicationsResponse> {
  return execute(req, (ctx) =>
    artworkPublicationService.list(req.params.id, ctx)
  );
}

export function handleCreateArtworkPublication(
  req: Operations.ArtworkDocumentationCreateArtworkPublicationRequest
): Promise<Operations.ArtworkDocumentationCreateArtworkPublicationResponse> {
  return execute(req, (ctx) =>
    artworkPublicationService.publish(
      req.params.id,
      req.body,
      mutation(req, true),
      ctx
    )
  );
}

export function handleWithdrawArtworkPublication(
  req: Operations.ArtworkDocumentationWithdrawArtworkPublicationRequest
): Promise<Operations.ArtworkDocumentationWithdrawArtworkPublicationResponse> {
  return execute(req, (ctx) =>
    artworkPublicationService.withdraw(
      req.params.id,
      req.params.publicationId,
      mutation(req),
      ctx
    )
  );
}
