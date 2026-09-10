import { createHash } from 'node:crypto';
import fetch from 'node-fetch';
import { ArweaveFileUploader, arweaveFileUploader } from '@/arweave';
import { CustomApiCompliantException } from '@/exceptions';
import { CmsPackageV1 } from '@/profile-cms/protocol/v1';
import {
  ProfileCmsUploadsDb,
  profileCmsUploadsDb
} from '@/profile-cms/profile-cms-uploads.db';
import { RequestContext } from '@/request.context';
import { Time } from '@/time';

type Receipt = CmsPackageV1['storage'][number];
export const CMS_MAX_STORAGE_BYTES = 2 * 1024 * 1024;

export function cmsBytesHash(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function receiptGateway(uri: string): string {
  const arweave = /^ar:\/\/([A-Za-z0-9_-]{43})$/.exec(uri);
  if (arweave) return `https://arweave.net/raw/${arweave[1]}`;
  const ipfs =
    /^ipfs:\/\/((?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,256}|z[1-9A-HJ-NP-Za-km-z]{20,256}))$/.exec(
      uri
    );
  if (ipfs) return `https://ipfs.io/ipfs/${ipfs[1]}`;
  throw new CustomApiCompliantException(
    400,
    'Canonical CMS storage must identify a root IPFS or Arweave object'
  );
}

export class ProfileCmsPublicationStorage {
  constructor(
    private readonly uploads: ProfileCmsUploadsDb = profileCmsUploadsDb,
    private readonly uploader: ArweaveFileUploader = arweaveFileUploader,
    private readonly download = fetch
  ) {}

  async verify(receipt: Receipt): Promise<Buffer> {
    const url = receiptGateway(receipt.uri);
    let bytes: Buffer;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await this.download(url, {
        redirect: 'error',
        signal: controller.signal,
        timeout: 8000,
        size: CMS_MAX_STORAGE_BYTES
      });
      // Arweave returns HTTP 202 with a pending marker before data propagates.
      // Only a complete HTTP 200 response contains bytes suitable for hashing.
      if (response.status !== 200) throw new Error('unavailable');
      bytes = await response.buffer();
    } catch {
      throw new CustomApiCompliantException(
        503,
        'CMS storage is not yet retrievable; retry after the upload propagates',
        'cms_storage_pending'
      );
    } finally {
      clearTimeout(timeout);
    }
    if (cmsBytesHash(bytes) !== receipt.content_hash) {
      throw new CustomApiCompliantException(
        400,
        'CMS storage bytes do not match the signed content hash',
        'cms_storage_hash_mismatch'
      );
    }
    return bytes;
  }

  async upload(
    params: {
      operationKey: string;
      profileId: string;
      packageDbId: string;
      bytes: Buffer;
    },
    ctx: RequestContext
  ): Promise<Receipt> {
    if (params.bytes.length > CMS_MAX_STORAGE_BYTES) {
      throw new CustomApiCompliantException(
        413,
        'CMS package exceeds the 2 MiB storage limit'
      );
    }
    if (!process.env.ARWEAVE_KEY)
      throw new CustomApiCompliantException(
        503,
        'CMS decentralized storage is not configured'
      );
    const id = createHash('sha256').update(params.operationKey).digest('hex');
    const reservation = await this.uploads.reserve(
      id,
      params.profileId,
      params.packageDbId,
      Time.currentMillis(),
      ctx
    );
    if (reservation.receipt) return reservation.receipt;
    let uploadState = reservation.uploadState;
    try {
      const result = await this.uploader.uploadFileWithTransactionId(
        params.bytes,
        'application/json',
        {
          savedState: uploadState,
          onState: async (state) => {
            await this.uploads.saveState(reservation, state, ctx);
            uploadState = state;
          }
        }
      );
      if (!/^[A-Za-z0-9_-]{43}$/.test(result.transaction_id))
        throw new Error('invalid transaction');
      const receipt: Receipt = {
        provider: 'arweave',
        uri: `ar://${result.transaction_id}`,
        content_hash: cmsBytesHash(
          uploadState
            ? Buffer.from(uploadState.data_base64, 'base64')
            : params.bytes
        ),
        provider_content_id: result.transaction_id,
        canonical: true,
        recorded_at: new Date().toISOString()
      };
      await this.uploads.complete(reservation, receipt, ctx);
      return receipt;
    } catch (error) {
      // Once a signed transaction is durable, retain the lease until expiry.
      // A retry resumes that transaction even if submission or receipt commit
      // succeeded remotely but its acknowledgement was lost.
      if (!uploadState) await this.uploads.release(reservation, ctx);
      if (error instanceof CustomApiCompliantException) throw error;
      throw new CustomApiCompliantException(
        502,
        'Failed to upload CMS package to decentralized storage'
      );
    }
  }
}

export const profileCmsPublicationStorage = new ProfileCmsPublicationStorage();
