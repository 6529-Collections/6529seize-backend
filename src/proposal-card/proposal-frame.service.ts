import * as Joi from 'joi';
import { ApiProposalFrameRequest } from '@/api/generated/models/ApiProposalFrameRequest';
import {
  ApiProposalFrameResponse,
  ApiProposalFrameResponseMimeTypeEnum
} from '@/api/generated/models/ApiProposalFrameResponse';
import {
  DROP_MEDIA_ALLOWED_EXTENSIONS_BY_MIME_TYPE,
  DROP_MEDIA_ALLOWED_MIME_TYPES
} from '@/api/media/media-mime-types';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import {
  IpfsFileUploader,
  ipfsFileUploader
} from '@/attachments/ipfs-file-uploader';
import { CLOUDFRONT_LINK } from '@/constants';
import {
  parseDecentralizedMediaRef,
  to6529ResolverUrl
} from '@/decentralized-media/decentralized-media';
import {
  DropMediaUploadsDb,
  dropMediaUploadsDb
} from '@/drops/drop-media-uploads.db';
import { DropMediaUploadStatus } from '@/entities/IDropMediaUpload';
import { BadRequestException, ForbiddenException } from '@/exceptions';
import { buildProposalCardDocument } from '@/proposal-card/document';

const SOURCE_MIME_TYPES = DROP_MEDIA_ALLOWED_MIME_TYPES.filter(
  (mime) => mime.startsWith('image/') || mime.startsWith('video/')
);

const BodySchema: Joi.ObjectSchema<ApiProposalFrameRequest> =
  Joi.object<ApiProposalFrameRequest>({
    media_url: Joi.string().max(2048).required(),
    mime_type: Joi.string()
      .valid(...SOURCE_MIME_TYPES, 'text/html')
      .required(),
    title: Joi.string().trim().min(1).max(250).required(),
    layout: Joi.string().valid('portrait', 'landscape').required()
  }).unknown(false);

export class ProposalFrameService {
  constructor(
    private readonly uploader: Pick<IpfsFileUploader, 'uploadDirectory'>,
    private readonly uploads: Pick<DropMediaUploadsDb, 'findByPublicUrl'>
  ) {}

  async publish(
    request: ApiProposalFrameRequest,
    profileId: string
  ): Promise<ApiProposalFrameResponse> {
    const body = getValidatedByJoiOrThrow(request, BodySchema);
    const mediaUrl = await this.validateSource(body, profileId);
    const document = buildProposalCardDocument({
      mediaUrl,
      mimeType: body.mime_type,
      title: body.title,
      layout: body.layout
    });
    const result = await this.uploader.uploadDirectory({
      files: [
        {
          fileName: 'index.html',
          fileBuffer: Buffer.from(document, 'utf8'),
          contentType: 'text/html'
        }
      ]
    });
    return {
      url: result.files['index.html'],
      mime_type: ApiProposalFrameResponseMimeTypeEnum.TextHtml
    };
  }

  private async validateSource(
    body: ApiProposalFrameRequest,
    profileId: string
  ): Promise<string> {
    const url = parseSourceUrl(body.media_url);
    const reference = parseDecentralizedMediaRef(body.media_url);
    if (reference) {
      return to6529ResolverUrl(reference);
    }
    if (body.mime_type === 'text/html') {
      throw new BadRequestException(
        'HTML artwork must be served from IPFS, IPNS, or Arweave'
      );
    }
    if (
      url.origin !== CLOUDFRONT_LINK ||
      url.search ||
      url.hash ||
      !url.pathname.startsWith(`/drops/author_${profileId}/`)
    ) {
      throw new ForbiddenException('Use artwork uploaded by your profile');
    }
    assertMediaExtension(url, body.mime_type);
    const upload = await this.uploads.findByPublicUrl(url.href);
    if (upload) {
      if (upload.profile_id !== profileId) {
        throw new ForbiddenException('Use artwork uploaded by your profile');
      }
      if (upload.status !== DropMediaUploadStatus.READY) {
        throw new BadRequestException('Wait for artwork processing to finish');
      }
      if (upload.declared_mime_type !== body.mime_type) {
        throw new BadRequestException(
          'Artwork MIME type does not match its upload'
        );
      }
    }
    return url.href;
  }
}

function parseSourceUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BadRequestException('Invalid artwork URL');
  }
  if (
    !['https:', 'ipfs:', 'ipns:', 'ar:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.port ||
    value.includes('\\') ||
    Array.from(value).some((character) => character.charCodeAt(0) <= 32)
  ) {
    throw new BadRequestException('Artwork must use a secure media URL');
  }
  return url;
}

function assertMediaExtension(url: URL, mimeType: string): void {
  const extensions =
    DROP_MEDIA_ALLOWED_EXTENSIONS_BY_MIME_TYPE[
      mimeType as (typeof SOURCE_MIME_TYPES)[number]
    ];
  if (
    !extensions?.some((extension) =>
      url.pathname.toLowerCase().endsWith(extension)
    )
  ) {
    throw new BadRequestException(
      'Artwork filename does not match its MIME type'
    );
  }
}

export const proposalFrameService = new ProposalFrameService(
  ipfsFileUploader,
  dropMediaUploadsDb
);
