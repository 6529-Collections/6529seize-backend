import fetch from 'node-fetch';
import { Logger } from '@/logging';

const FormData = require('form-data');

type IpfsDirectoryFile = {
  fileName: string;
  fileBuffer: Buffer;
  contentType: string;
};

const DEFAULT_DIRECTORY_UPLOAD_PATH =
  '/api/v0/add?pin=true&wrap-with-directory=true';

function getDirectoryUploadPath(): string {
  return process.env.IPFS_API_UPLOAD_PATH ?? DEFAULT_DIRECTORY_UPLOAD_PATH;
}

// Single files use the configured add path without the wrapping directory.
function getFileUploadPath(): string {
  const directoryPath = getDirectoryUploadPath();
  const queryStart = directoryPath.indexOf('?');
  if (queryStart < 0) {
    return directoryPath;
  }
  const params = new URLSearchParams(directoryPath.slice(queryStart + 1));
  params.delete('wrap-with-directory');
  const query = params.toString();
  const path = directoryPath.slice(0, queryStart);
  return query ? `${path}?${query}` : path;
}

export class IpfsFileUploader {
  private readonly logger = Logger.get(this.constructor.name);

  public async uploadDirectory({
    files
  }: {
    files: IpfsDirectoryFile[];
  }): Promise<{
    cid: string;
    url: string;
    files: Record<string, string>;
  }> {
    const cid = await this.add(files, getDirectoryUploadPath());
    const rootUrl = `ipfs://${cid}`;
    const fileUrls = files.reduce(
      (acc, file) => {
        acc[file.fileName] = `${rootUrl}/${encodeURIComponent(file.fileName)}`;
        return acc;
      },
      {} as Record<string, string>
    );
    this.logger.info(`Uploaded attachment bundle to IPFS cid=${cid}`);
    return {
      cid,
      url: rootUrl,
      files: fileUrls
    };
  }

  /**
   * Adds and pins one file on its own, without a wrapping directory. The add
   * response then has a single entry, the file itself, whose hash is the CID.
   */
  public async uploadFile(file: IpfsDirectoryFile): Promise<{
    cid: string;
    url: string;
  }> {
    const cid = await this.add([file], getFileUploadPath());
    this.logger.info(`Uploaded file to IPFS cid=${cid}`);
    return { cid, url: `ipfs://${cid}` };
  }

  private async add(
    files: IpfsDirectoryFile[],
    uploadPath: string
  ): Promise<string> {
    const apiEndpoint = process.env.IPFS_API_ENDPOINT;
    if (!apiEndpoint) {
      throw new Error('IPFS_API_ENDPOINT not configured');
    }

    const form = new FormData();
    for (const file of files) {
      form.append('file', file.fileBuffer, {
        filename: file.fileName,
        contentType: file.contentType
      });
    }

    const response = await fetch(
      `${apiEndpoint.replace(/\/$/, '')}${uploadPath}`,
      {
        method: 'POST',
        body: form as any,
        headers: typeof form.getHeaders === 'function' ? form.getHeaders() : {}
      }
    );

    const body = await response.text();
    if (!response.ok) {
      throw new Error(
        `IPFS upload failed with status ${response.status}: ${body.slice(0, 500)}`
      );
    }

    return this.extractRootCid(this.extractItems(body));
  }

  private extractItems(responseBody: string): Record<string, unknown>[] {
    return responseBody
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((it): it is Record<string, unknown> => it !== null);
  }

  private extractRootCid(items: Record<string, unknown>[]): string {
    const reversedItems = [...items].reverse();
    for (const candidate of reversedItems) {
      const cid = candidate.Hash ?? candidate.cid ?? candidate.Cid;
      if (typeof cid === 'string' && cid.trim()) {
        return cid.trim();
      }
    }
    throw new Error(`Unable to extract CID from IPFS response`);
  }
}

export const ipfsFileUploader = new IpfsFileUploader();
