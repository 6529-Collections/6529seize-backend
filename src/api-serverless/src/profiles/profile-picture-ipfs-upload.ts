import {
  IpfsFileUploader,
  ipfsFileUploader
} from '@/attachments/ipfs-file-uploader';
import { prepareProfilePictureUpload } from './profile-picture-preparation';

export {
  detectProfilePictureFormat,
  prepareProfilePictureUpload,
  PROFILE_PICTURE_MAX_BYTES,
  stripProfilePictureMetadata
} from './profile-picture-preparation';
export type { PreparedProfilePicture } from './profile-picture-preparation';

export class ProfilePictureIpfsUploadService {
  constructor(
    private readonly uploader: Pick<IpfsFileUploader, 'uploadFile'>
  ) {}

  public async upload(
    file: Pick<Express.Multer.File, 'buffer'> | undefined
  ): Promise<{ pfp_url: string }> {
    const picture = prepareProfilePictureUpload(file);
    const { url } = await this.uploader.uploadFile({
      fileName: `pfp.${picture.extension}`,
      fileBuffer: picture.bytes,
      contentType: picture.contentType
    });
    return { pfp_url: url };
  }
}

export const profilePictureIpfsUploadService =
  new ProfilePictureIpfsUploadService(ipfsFileUploader);
