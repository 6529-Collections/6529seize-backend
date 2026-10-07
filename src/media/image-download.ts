import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import type { IAxiosRetryConfig } from 'axios-retry';
import sharp from 'sharp';
import { withArweaveFallback } from '@/arweave-gateway-fallback';
import { Logger } from '@/logging';
import { FailureCategory } from '@/operational-errors';

const logger = Logger.get('IMAGE_DOWNLOAD');
const GATEWAY_TIMEOUT_MS = 15_000;
const REQUEST_OPTIONS: AxiosRequestConfig & {
  'axios-retry': Pick<IAxiosRetryConfig, 'retries'>;
} = {
  responseType: 'arraybuffer',
  timeout: GATEWAY_TIMEOUT_MS,
  // Rotate gateways promptly. SQS owns retries after all gateways fail.
  'axios-retry': { retries: 0 }
};

type DownloadFailure = {
  category: FailureCategory;
  reason: string;
  gateway: string;
  httpStatus?: number;
  bytes?: number;
};

export class ImageSourceUnavailableError extends Error {
  constructor(
    public readonly attempts: number,
    public readonly failure: DownloadFailure
  ) {
    super(
      `No gateway returned a valid image after ${attempts} attempts; ` +
        `last gateway=${failure.gateway} reason=${failure.reason}`
    );
    this.name = 'ImageSourceUnavailableError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function gatewayHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'unknown';
  }
}

function requestFailure(error: unknown, gateway: string): DownloadFailure {
  if (axios.isAxiosError(error)) {
    const httpStatus = error.response?.status;
    return {
      category: httpStatus
        ? 'HTTP_ERROR'
        : error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT'
          ? 'TIMEOUT'
          : 'NETWORK',
      reason: httpStatus ? 'HTTP_ERROR' : 'REQUEST_FAILED',
      gateway,
      httpStatus
    };
  }
  return { category: 'NETWORK', reason: 'REQUEST_FAILED', gateway };
}

/** Validation belongs inside the gateway attempt: a 200 with no usable image
 * must advance fallback, never be cached or uploaded as an original. */
export async function downloadImageBuffer(url: string): Promise<Buffer> {
  let attempts = 0;
  let lastFailure: DownloadFailure = {
    category: 'UNKNOWN',
    reason: 'NO_RESPONSE',
    gateway: gatewayHost(url)
  };
  try {
    return await withArweaveFallback(url, async (candidate) => {
      attempts++;
      const gateway = gatewayHost(candidate);
      let response: AxiosResponse<ArrayBuffer>;
      try {
        response = await axios.get<ArrayBuffer>(candidate, REQUEST_OPTIONS);
      } catch (error) {
        lastFailure = requestFailure(error, gateway);
        logFailure(lastFailure, attempts);
        throw new Error(lastFailure.reason);
      }
      const buffer = Buffer.from(response.data);
      lastFailure = {
        // This is unavailable upstream content, not an invalid uploader job.
        category: 'NETWORK',
        reason: buffer.length ? 'INVALID_IMAGE' : 'EMPTY_BODY',
        gateway,
        httpStatus: response.status,
        bytes: buffer.length
      };
      try {
        if (!buffer.length) throw new Error('EMPTY_BODY');
        // Decode the first frame before uploading. Header-only inspection can
        // accept truncated images that will subsequently fail during resizing.
        await sharp(buffer)
          .resize({ width: 1, height: 1, fit: 'inside' })
          .raw()
          .toBuffer();
      } catch {
        logFailure(lastFailure, attempts);
        throw new Error(lastFailure.reason);
      }
      logger.info(
        `[IMAGE_DOWNLOAD_ACCEPTED] [gateway=${gateway}] [status=${response.status}] ` +
          `[bytes=${buffer.length}] [attempt=${attempts}]`
      );
      return buffer;
    });
  } catch {
    // Do not propagate Axios config, signed URLs, response bodies or query tokens.
    throw new ImageSourceUnavailableError(attempts, lastFailure);
  }
}

function logFailure(failure: DownloadFailure, attempt: number): void {
  logger.warn(
    `[IMAGE_DOWNLOAD_REJECTED] [gateway=${failure.gateway}] ` +
      `[status=${failure.httpStatus ?? 'none'}] [bytes=${failure.bytes ?? 'unknown'}] ` +
      `[reason=${failure.reason}] [attempt=${attempt}]`
  );
}
