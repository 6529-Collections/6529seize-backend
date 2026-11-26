import { ipfsFileUploader } from '@/attachments/ipfs-file-uploader';
import type { MintContentPort } from './mint-log-genesis';

/** Where genesis files are read from when nothing else is configured. */
export const DEFAULT_MINT_LOG_FILES_URL = 'https://ipfs.io';

const FETCH_TIMEOUT_MS = 60_000;

/**
 * Genesis files on IPFS: written through the API's IPFS uploader, read
 * through a gateway (the rebuild's files source). The rebuild checks each
 * file's sha256 against the genesis entry, so the gateway need not be
 * trusted.
 */
export function ipfsMintContent(
  filesUrl: string = process.env.MINT_LOG_FILES_URL ??
    DEFAULT_MINT_LOG_FILES_URL,
  fetchImpl: typeof fetch = fetch
): MintContentPort {
  const base = filesUrl.replace(/\/+$/, '');
  return {
    put: async (name, bytes) =>
      (
        await ipfsFileUploader.uploadFile({
          fileName: name,
          fileBuffer: bytes,
          contentType: 'application/gzip'
        })
      ).cid,
    get: async (cid) => {
      if (!/^[A-Za-z0-9]+$/.test(cid)) {
        throw new Error(`Not a CID: ${cid}`);
      }
      const response = await fetchImpl(`${base}/ipfs/${cid}`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      });
      if (!response.ok) {
        throw new Error(`Genesis file ${cid}: HTTP ${response.status}`);
      }
      return Buffer.from(await response.arrayBuffer());
    }
  };
}
