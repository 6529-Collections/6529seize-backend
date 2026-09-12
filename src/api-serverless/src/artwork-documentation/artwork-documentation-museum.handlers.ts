import * as Operations from '@/api/generated/routes/operations';
import { museumRecordService } from '@/artwork-documentation/institution/museum-record.service';
import { artworkDossierService } from '@/artwork-documentation/museum/export/dossier.service';
import { artworkDocumentationService } from '@/artwork-documentation/artwork-documentation.service';
import { execute, mutation } from './artwork-documentation.handlers';

export function handleGetArtworkArtistRecord(
  req: Operations.ArtworkDocumentationGetArtworkArtistRecordRequest
): Promise<Operations.ArtworkDocumentationGetArtworkArtistRecordResponse> {
  return execute(req, (ctx) =>
    artworkDocumentationService.artistRecordForContext(
      req.params.id,
      req.params.revisionId,
      ctx
    )
  );
}

export function handleListMuseumRecords(
  req: Operations.ArtworkDocumentationListMuseumRecordsRequest
): Promise<Operations.ArtworkDocumentationListMuseumRecordsResponse> {
  return execute(req, (ctx) =>
    museumRecordService.list(req.params.id, ctx, req.query.before)
  );
}

export function handleAppendMuseumRecord(
  req: Operations.ArtworkDocumentationAppendMuseumRecordRequest
): Promise<Operations.ArtworkDocumentationAppendMuseumRecordResponse> {
  return execute(req, (ctx) =>
    museumRecordService.append(
      req.params.id,
      req.body,
      mutation(req, true),
      ctx
    )
  );
}

export function handleGetArtworkDossier(
  req: Operations.ArtworkDocumentationGetArtworkDossierRequest
): Promise<Operations.ArtworkDocumentationGetArtworkDossierResponse> {
  return execute(req, (ctx) =>
    artworkDossierService.inspect(req.params.id, ctx)
  );
}

export function handleCreateArtworkDossierExport(
  req: Operations.ArtworkDocumentationCreateArtworkDossierExportRequest
): Promise<Operations.ArtworkDocumentationCreateArtworkDossierExportResponse> {
  return execute(req, (ctx) =>
    artworkDossierService.create(
      req.params.id,
      req.body,
      mutation(req, true),
      ctx
    )
  );
}

export function handleGetArtworkDossierExport(
  req: Operations.ArtworkDocumentationGetArtworkDossierExportRequest
): Promise<Operations.ArtworkDocumentationGetArtworkDossierExportResponse> {
  return execute(req, (ctx) =>
    artworkDossierService.get(req.params.id, req.params.exportId, ctx)
  );
}
