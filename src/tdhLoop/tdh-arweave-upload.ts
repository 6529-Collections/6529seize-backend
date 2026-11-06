import Arweave from 'arweave';
import Transaction from 'arweave/node/lib/transaction';
import { JWKInterface } from 'arweave/node/lib/wallet';
import { setTimeout as sleep } from 'node:timers/promises';
import { Logger } from '@/logging';

const GATEWAYS = ['ardrive.net', 'turbo-gateway.com', 'arweave.net'];
const REQUEST_TIMEOUT_MS = 10_000;
const UPLOAD_TIMEOUT_MS = 120_000;
const ATTEMPTS_PER_GATEWAY = 2;
const CHUNK_CONCURRENCY = 8;

type UploadLogger = Pick<Logger, 'info' | 'warn' | 'error'>;
type UploadResult = { url: string; transactionId: string };
type Operation = {
  path: string;
  method: 'GET' | 'POST';
  body?: string;
  chunk?: number;
  validate?: (body: string) => boolean;
};

class GatewayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryable: boolean
  ) {
    super(`HTTP ${status}: ${code}`);
    Object.setPrototypeOf(this, GatewayError.prototype);
  }
}

function providerCode(body: string): string {
  let value: unknown;
  try {
    const details: unknown = JSON.parse(body);
    if (details && typeof details === 'object') {
      if ('error' in details) value = details.error;
      else if ('details' in details) value = details.details;
    }
  } catch {
    value = body;
  }
  // Record short provider codes, never reflected request bodies or stacks.
  return typeof value === 'string' && /^[\w .:-]{1,160}$/.test(value.trim())
    ? value.trim()
    : 'gateway_error';
}

function providerError(status: number, body: string): GatewayError {
  const code = providerCode(body);
  const transient = [
    'data_root_not_found',
    'exceeds_disk_pool_size_limit',
    'not_joined',
    'timeout'
  ];
  return new GatewayError(
    status,
    code,
    status >= 500 ||
      status === 408 ||
      status === 429 ||
      status === 404 ||
      transient.includes(code)
  );
}

class UploadSession {
  private readonly controller = new AbortController();
  private gatewayIndex = 0;
  private transactionId = 'unsigned';
  private signedHeader = '';
  private readonly headers = new Map<string, Promise<void>>();
  private stopped: Error | undefined;

  constructor(private readonly logger: UploadLogger) {}

  async upload(csv: string, key: JWKInterface): Promise<UploadResult> {
    const deadline = setTimeout(
      () =>
        this.stop(
          new Error(
            `TDH Arweave upload exceeded ${UPLOAD_TIMEOUT_MS}ms deadline`
          )
        ),
      UPLOAD_TIMEOUT_MS
    );
    try {
      return await this.publish(Buffer.from(csv), key);
    } catch (error) {
      const failure =
        this.stopped ??
        (error instanceof Error
          ? error
          : new Error('TDH Arweave upload failed'));
      this.stop(failure);
      this.logger.error(
        `[ARWEAVE UPLOAD FAILED] [TX ${this.transactionId}] [ERROR ${failure.message}]`
      );
      throw failure;
    } finally {
      clearTimeout(deadline);
    }
  }

  private async publish(
    data: Buffer,
    key: JWKInterface
  ): Promise<UploadResult> {
    const [anchor, reward] = await Promise.all([
      this.request({
        path: 'tx_anchor',
        method: 'GET',
        validate: (body) => /^[\w-]{43,64}$/.test(body)
      }),
      this.request({
        path: `price/${data.byteLength}`,
        method: 'GET',
        validate: (body) => /^\d+$/.test(body)
      })
    ]);
    this.throwIfStopped();
    const arweave = Arweave.init({
      host: GATEWAYS[0],
      protocol: 'https',
      port: 443
    });
    // Supply bounded metadata requests explicitly: the SDK's fetch has no timeout.
    const transaction = await arweave.createTransaction(
      { data, last_tx: anchor, reward },
      key
    );
    transaction.addTag('Content-Type', 'text/csv');
    await arweave.transactions.sign(transaction, key);
    this.transactionId = transaction.id;
    this.signedHeader = JSON.stringify(
      new Transaction({ ...transaction, data: new Uint8Array(0) }).toJSON()
    );
    // Failover always resubmits the same signed header and immutable chunks.
    await this.request({
      path: 'tx',
      method: 'POST',
      body: this.signedHeader
    });
    await this.uploadChunks(transaction, data);
    this.logger.info(`[ARWEAVE UPLOAD COMPLETE] [TX ${transaction.id}]`);
    return {
      url: `https://arweave.net/${transaction.id}`,
      transactionId: transaction.id
    };
  }

  private async uploadChunks(
    transaction: Transaction,
    data: Buffer
  ): Promise<void> {
    await transaction.prepareChunks(data);
    const total = transaction.chunks!.chunks.length;
    let next = 0;
    let completed = 0;
    const workers = Array.from(
      { length: Math.min(CHUNK_CONCURRENCY, total) },
      async () => {
        while (next < total) {
          this.throwIfStopped();
          const chunk = next++;
          await this.request({
            path: 'chunk',
            method: 'POST',
            body: JSON.stringify(transaction.getChunk(chunk, data)),
            chunk
          });
          completed++;
          if (completed % 25 === 0 || completed === total) {
            this.logger.info(
              `[ARWEAVE UPLOAD] [TX ${transaction.id}] [CHUNKS ${completed}/${total}]`
            );
          }
        }
      }
    );
    try {
      await Promise.all(workers);
    } catch (error) {
      this.stop(
        error instanceof Error ? error : new Error('Chunk upload failed')
      );
      await Promise.allSettled(workers);
      throw error;
    }
  }

  private async request(operation: Operation): Promise<string> {
    const firstGateway = this.gatewayIndex;
    const attempts = GATEWAYS.length * ATTEMPTS_PER_GATEWAY;
    for (let attempt = 0; attempt < attempts; attempt++) {
      this.throwIfStopped();
      const index = (firstGateway + attempt) % GATEWAYS.length;
      const gateway = GATEWAYS[index];
      let requestedOperation = operation;
      try {
        if (operation.path === 'chunk') {
          requestedOperation = {
            path: 'tx',
            method: 'POST',
            body: this.signedHeader
          };
          await this.ensureHeader(gateway, requestedOperation);
          requestedOperation = operation;
        }
        const body = await this.fetch(gateway, operation);
        if (operation.path === 'tx')
          this.headers.set(gateway, Promise.resolve());
        this.gatewayIndex = index;
        return body;
      } catch (error) {
        this.throwIfStopped();
        const failure =
          error instanceof GatewayError
            ? error
            : new GatewayError(0, 'network_error', true);
        const context = `[TX ${this.transactionId}] [GATEWAY ${gateway}] [OP ${requestedOperation.method} ${requestedOperation.path}] [CHUNK ${operation.chunk ?? '-'}] [ATTEMPT ${attempt + 1}/${attempts}] [STATUS ${failure.status}] [ERROR ${failure.code}]`;
        this.logger.warn(`[ARWEAVE REQUEST FAILED] ${context}`);
        if (!failure.retryable || attempt + 1 === attempts) {
          throw new Error(`Arweave request failed ${context}`);
        }
        await sleep(250, undefined, { signal: this.controller.signal });
      }
    }
    throw new Error('Arweave request exhausted its retry budget');
  }

  private ensureHeader(gateway: string, operation: Operation): Promise<void> {
    const existing = this.headers.get(gateway);
    if (existing) return existing;
    const pending = this.fetch(gateway, operation)
      .then(() => undefined)
      .catch((error: unknown) => {
        if (this.headers.get(gateway) === pending) this.headers.delete(gateway);
        throw error;
      });
    this.headers.set(gateway, pending);
    return pending;
  }

  private async fetch(gateway: string, operation: Operation): Promise<string> {
    const requestController = new AbortController();
    const onAbort = () => requestController.abort();
    this.controller.signal.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(
      () => requestController.abort(),
      REQUEST_TIMEOUT_MS
    );
    try {
      this.throwIfStopped();
      const response = await fetch(`https://${gateway}/${operation.path}`, {
        method: operation.method,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/plain, */*'
        },
        body: operation.body,
        signal: requestController.signal
      });
      const body = await response.text();
      if (!response.ok) throw providerError(response.status, body);
      if (operation.validate && !operation.validate(body)) {
        throw new GatewayError(response.status, 'invalid_response', true);
      }
      return body;
    } catch (error) {
      this.throwIfStopped();
      if (error instanceof GatewayError) throw error;
      throw new GatewayError(
        0,
        requestController.signal.aborted ? 'request_timeout' : 'network_error',
        true
      );
    } finally {
      clearTimeout(timeout);
      this.controller.signal.removeEventListener('abort', onAbort);
    }
  }

  private stop(error: Error): void {
    this.stopped ??= error;
    this.controller.abort();
  }

  private throwIfStopped(): void {
    if (this.stopped) throw this.stopped;
  }
}

export async function uploadTdhCsvToArweave(
  csv: string,
  key: JWKInterface,
  logger: UploadLogger
): Promise<UploadResult> {
  return new UploadSession(logger).upload(csv, key);
}
