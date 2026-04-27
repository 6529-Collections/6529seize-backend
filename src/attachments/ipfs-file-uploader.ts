import fetch from 'node-fetch';
import { Logger } from '@/logging';

const FormData = require('form-data');

type IpfsDirectoryFile = {
  fileName: string;
  fileBuffer: Buffer;
  contentType: string;
};

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

    const uploadPath =
      process.env.IPFS_API_UPLOAD_PATH ??
      '/api/v0/add?pin=true&wrap-with-directory=true';
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

    const items = this.extractItems(body);
    const cid = this.extractRootCid(items);
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
    for (const candidate of items.reverse()) {
      const cid = candidate.Hash ?? candidate.cid ?? candidate.Cid;
      if (typeof cid === 'string' && cid.trim()) {
        return cid.trim();
      }
    }
    throw new Error(`Unable to extract CID from IPFS response`);
  }
}

export const ipfsFileUploader = new IpfsFileUploader();
