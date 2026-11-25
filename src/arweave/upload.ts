import { isTransactionConfirmationText } from '@/arweave/transaction-status';
import Arweave from 'arweave';
import { createArweaveClient } from '@/arweave/client';
import { ARWEAVE_WRITE_GATEWAYS as GATEWAYS } from '@/arweave/gateways';
import type { ArweaveUploadHooks, ArweaveUploadState } from '@/arweave';
import Transaction from 'arweave/node/lib/transaction';
import { JWKInterface } from 'arweave/node/lib/wallet';
import { Logger } from '@/logging';

const REQUEST_TIMEOUT_MS = 10_000;
const UPLOAD_TIMEOUT_MS = 120_000;
const ATTEMPTS_PER_GATEWAY = 2;
const CHUNK_CONCURRENCY = 8;
const PROPAGATION_DELAY_MS = 30_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const FATAL_CHUNK_ERRORS = new Set([
  'invalid_json',
  'chunk_too_big',
  'data_path_too_big',
  'offset_too_big',
  'data_size_too_big',
  'chunk_proof_ratio_not_attractive',
  'invalid_proof'
]);

type UploadLogger = Pick<Logger, 'info' | 'warn' | 'error'>;
type UploadResult = { url: string; transactionId: string };
type Operation = {
  path: string;
  method: 'GET' | 'POST';
  body?: string;
  chunk?: number;
  validate?: (body: string, status: number) => boolean;
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

async function boundedResponseText(response: Response): Promise<string> {
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new GatewayError(response.status, 'response_too_large', true);
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  const readNext = async (): Promise<string> => {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks, bytes).toString('utf8');
    bytes += value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES)
      throw new GatewayError(response.status, 'response_too_large', true);
    chunks.push(Buffer.from(value));
    return readNext();
  };
  try {
    return await readNext();
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

function peerStatus(result: unknown): number[] {
  return result &&
    typeof result === 'object' &&
    'statusCode' in result &&
    typeof result.statusCode === 'number' &&
    Number.isInteger(result.statusCode) &&
    result.statusCode >= 100 &&
    result.statusCode <= 599
    ? [result.statusCode]
    : [];
}

function peerFailureCode(details: object): string | undefined {
  if (
    !('results' in details) ||
    !Array.isArray(details.results) ||
    !('successCount' in details) ||
    typeof details.successCount !== 'number' ||
    !Number.isSafeInteger(details.successCount) ||
    !('failureCount' in details) ||
    typeof details.failureCount !== 'number' ||
    !Number.isSafeInteger(details.failureCount)
  )
    return undefined;
  const statuses = Array.from(new Set(details.results.flatMap(peerStatus)))
    .sort((a, b) => a - b)
    .slice(0, 8);
  // Compose only numeric diagnostics, excluding peer URLs and response bodies.
  return `peer_upload_failed:success_${details.successCount}:failure_${details.failureCount}:statuses_${statuses.join('_') || 'unknown'}`;
}

const PROVIDER_CODES = new Set([
  ...Array.from(FATAL_CHUNK_ERRORS),
  'not_joined',
  'timeout',
  'data_root_not_found',
  'exceeds_disk_pool_size_limit',
  'tx_not_found',
  'invalid_tx',
  'invalid_signature',
  'insufficient_funds',
  'tx_already_exists'
]);

function knownProviderCode(value: unknown): string {
  return typeof value === 'string' && PROVIDER_CODES.has(value.trim())
    ? value.trim()
    : 'gateway_error';
}

function providerCode(body: string): string {
  let details: unknown;
  try {
    details = JSON.parse(body);
  } catch {
    return knownProviderCode(body);
  }
  if (typeof details === 'string') return knownProviderCode(details);
  if (!details || typeof details !== 'object') return 'gateway_error';
  if ('error' in details) return knownProviderCode(details.error);
  if ('details' in details) return knownProviderCode(details.details);
  return peerFailureCode(details) ?? 'gateway_error';
}

class UploadRequestError extends Error {
  constructor(
    context: string,
    readonly status: number
  ) {
    super(`Arweave request failed ${context}`);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function providerError(status: number, body: string): GatewayError {
  const code = providerCode(body);
  // A broadcaster can return HTTP 400 for peers missing a fresh header.
  // Only explicit protocol validation errors establish a permanent failure.
  return new GatewayError(
    status,
    code,
    status !== 400 || !FATAL_CHUNK_ERRORS.has(code)
  );
}

function retryDelay(operation: Operation, attempt: number): number {
  return operation.path === 'chunk' && (attempt + 1) % GATEWAYS.length === 0
    ? PROPAGATION_DELAY_MS
    : 250 * (attempt + 1);
}

export class ArweaveUploadSession {
  private readonly controller = new AbortController();
  private gatewayIndex = 0;
  private transactionId = 'unsigned';
  private signedHeader = '';
  private readonly headers = new Map<string, Promise<void>>();
  private stopped: Error | undefined;

  private state: ArweaveUploadState | undefined;
  private hooks: ArweaveUploadHooks | undefined;
  constructor(
    private readonly logger: UploadLogger,
    private readonly client: Arweave = createArweaveClient(),
    private readonly timeoutMs = UPLOAD_TIMEOUT_MS,
    private readonly inlineSmallUploads = false
  ) {}

  async upload(
    data: Buffer,
    key: JWKInterface,
    contentType: string,
    hooks?: ArweaveUploadHooks
  ): Promise<UploadResult> {
    this.hooks = hooks;
    const deadline = setTimeout(
      () =>
        this.stop(
          new Error(`Arweave upload exceeded ${this.timeoutMs}ms deadline`)
        ),
      this.timeoutMs
    );
    try {
      return await this.publish(data, key, contentType);
    } catch (error) {
      const failure =
        this.stopped ??
        (error instanceof Error ? error : new Error('Arweave upload failed'));
      this.stop(failure);
      this.logger.error(
        `[ARWEAVE UPLOAD FAILED] [TX ${this.transactionId}] [ERROR ${failure.message}]`
      );
      throw failure;
    } finally {
      clearTimeout(deadline);
    }
  }

  private async checkpoint(): Promise<void> {
    this.throwIfStopped();
    if (this.state && this.hooks) {
      const signal = this.controller.signal;
      let onAbort!: () => void;
      const cancelled = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(this.stopped ?? new Error('Upload cancelled'));
        signal.addEventListener('abort', onAbort, { once: true });
      });
      try {
        await Promise.race([
          this.hooks.onState(structuredClone(this.state), { signal }),
          cancelled
        ]);
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    }
    this.throwIfStopped();
  }

  private async prepare(
    data: Buffer,
    key: JWKInterface,
    contentType: string
  ): Promise<{ transaction: Transaction; data: Buffer }> {
    const saved = this.hooks?.savedState;
    if (saved) {
      data = Buffer.from(saved.data_base64, 'base64');
      if (data.toString('base64') !== saved.data_base64)
        throw new Error('Invalid persisted Arweave upload data');
      // The SDK rebuilds and validates chunk proofs against the signed data root.
      const restored = await this.client.transactions.getUploader(saved, data);
      const transaction = restored.toJSON().transaction;
      this.transactionId = transaction.id;
      this.state = structuredClone(saved);
      if (!this.state.txPosted)
        this.state.txPosted = await this.isPersistedTransactionKnown(
          transaction.id
        );
      return { transaction, data };
    }
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
    const transaction = await this.client.createTransaction(
      { data, last_tx: anchor, reward },
      key
    );
    transaction.addTag('Content-Type', contentType);
    await this.client.transactions.sign(transaction, key);
    await transaction.prepareChunks(data);
    this.state = {
      transaction: new Transaction({
        ...transaction,
        data: new Uint8Array(0)
      }).toJSON(),
      data_base64: this.hooks ? data.toString('base64') : '',
      chunkIndex: 0,
      txPosted: false,
      lastRequestTimeEnd: 0,
      lastResponseStatus: 0,
      lastResponseError: ''
    };
    return { transaction, data };
  }

  private async isPersistedTransactionKnown(id: string): Promise<boolean> {
    try {
      await this.request({
        path: `tx/${id}/status`,
        method: 'GET',
        validate: (body, status) =>
          status === 202 ||
          (status === 200 && isTransactionConfirmationText(body))
      });
      return true;
    } catch (error) {
      if (error instanceof UploadRequestError && error.status === 404)
        return false;
      throw error;
    }
  }

  private async publish(
    data: Buffer,
    key: JWKInterface,
    contentType: string
  ): Promise<UploadResult> {
    const prepared = await this.prepare(data, key, contentType);
    const transaction = prepared.transaction;
    data = prepared.data;
    this.transactionId = transaction.id;
    this.signedHeader = JSON.stringify(
      new Transaction({ ...transaction, data: new Uint8Array(0) }).toJSON()
    );
    // Re-emit the saved prefix before resuming; chunkIndex is a count of
    // acknowledged, durably checkpointed chunks, not a zero-based chunk ID.
    await this.checkpoint();
    if (!this.state!.txPosted) {
      // Preserve the file uploader's inline-data contract for new, one-chunk
      // transactions. A saved header/status alone never proves data acceptance.
      const inline =
        this.inlineSmallUploads &&
        !this.hooks?.savedState &&
        transaction.chunks!.chunks.length === 1;
      const dataAcknowledged = await this.submitTransaction(
        transaction,
        inline
      );
      this.state!.txPosted = true;
      if (dataAcknowledged) this.state!.chunkIndex = 1;
      await this.checkpoint();
    }
    await this.uploadChunks(transaction, data);
    this.logger.info(`[ARWEAVE UPLOAD COMPLETE] [TX ${transaction.id}]`);
    return {
      // Keep the public link on our primary gateway as well: another gateway
      // can accept a transaction while arweave.net serves an empty response.
      url: `https://${GATEWAYS[0]}/${transaction.id}`,
      transactionId: transaction.id
    };
  }

  private async submitTransaction(
    transaction: Transaction,
    inline: boolean
  ): Promise<boolean> {
    try {
      await this.request({
        path: 'tx',
        method: 'POST',
        body: inline ? JSON.stringify(transaction.toJSON()) : this.signedHeader,
        ...(inline
          ? { validate: (_body: string, status: number) => status === 200 }
          : {})
      });
      return inline;
    } catch (error) {
      // An already-processed header may outlive a lost inline acknowledgement.
      // Keep that signed transaction, but require /chunk to prove data acceptance.
      if (
        inline &&
        error instanceof UploadRequestError &&
        error.status >= 200 &&
        error.status < 300
      )
        return false;
      throw error;
    }
  }

  private async uploadChunks(
    transaction: Transaction,
    data: Buffer
  ): Promise<void> {
    await transaction.prepareChunks(data);
    const total = transaction.chunks!.chunks.length;
    let next = this.state!.chunkIndex;
    let completed = next;
    const uploadNext = async (): Promise<void> => {
      this.throwIfStopped();
      if (next >= total) return;
      const chunk = next++;
      await this.request({
        path: 'chunk',
        method: 'POST',
        body: JSON.stringify(transaction.getChunk(chunk, data)),
        chunk
      });
      completed++;
      if (this.hooks) {
        this.state!.chunkIndex = completed;
        await this.checkpoint();
      }
      if (completed % 25 === 0 || completed === total) {
        this.logger.info(
          `[ARWEAVE UPLOAD] [TX ${transaction.id}] [CHUNKS ${completed}/${total}]`
        );
      }
      return uploadNext();
    };
    // A persisted index must describe a contiguous prefix. Durable mode must
    // finish each checkpoint before another chunk starts; TDH retains parallelism.
    const concurrency = this.hooks ? 1 : CHUNK_CONCURRENCY;
    const workers = Array.from(
      { length: Math.min(concurrency, total - next) },
      uploadNext
    );
    try {
      await Promise.all(workers);
      this.state!.chunkIndex = total;
    } catch (error) {
      this.stop(
        error instanceof Error ? error : new Error('Chunk upload failed')
      );
      await Promise.allSettled(workers);
      throw error;
    }
  }

  private request(operation: Operation): Promise<string> {
    return this.requestAttempt(operation, this.gatewayIndex, 0);
  }

  private async requestAttempt(
    operation: Operation,
    firstGateway: number,
    attempt: number
  ): Promise<string> {
    this.throwIfStopped();
    const attempts = GATEWAYS.length * ATTEMPTS_PER_GATEWAY;
    const index = (firstGateway + attempt) % GATEWAYS.length;
    const gateway = GATEWAYS[index];
    let requestedOperation = operation;
    let registration: Promise<void> | undefined;
    try {
      if (operation.path === 'chunk') {
        requestedOperation = {
          path: 'tx',
          method: 'POST',
          body: this.signedHeader
        };
        registration = this.ensureHeader(gateway, requestedOperation);
        await registration;
        requestedOperation = operation;
      }
      const body = await this.fetch(gateway, operation);
      if (operation.path === 'tx') this.headers.set(gateway, Promise.resolve());
      this.gatewayIndex = index;
      return body;
    } catch (error) {
      this.throwIfStopped();
      const failure =
        error instanceof GatewayError
          ? error
          : new GatewayError(0, 'network_error', true);
      this.discardMissingHeader(
        gateway,
        registration,
        requestedOperation,
        failure
      );
      const context = `[TX ${this.transactionId}] [GATEWAY ${gateway}] [OP ${requestedOperation.method} ${requestedOperation.path}] [CHUNK ${operation.chunk ?? '-'}] [ATTEMPT ${attempt + 1}/${attempts}] [STATUS ${failure.status}] [ERROR ${failure.code}]`;
      this.logger.warn(`[ARWEAVE REQUEST FAILED] ${context}`);
      if (!failure.retryable || attempt + 1 === attempts)
        throw new UploadRequestError(context, failure.status);
      // Gateway attempts depend on the preceding result; a second chunk round
      // allows fresh headers to propagate, within the overall upload deadline.
      await this.pause(retryDelay(operation, attempt));
      return this.requestAttempt(operation, firstGateway, attempt + 1);
    }
  }

  private discardMissingHeader(
    gateway: string,
    registration: Promise<void> | undefined,
    operation: Operation,
    failure: GatewayError
  ): void {
    if (
      operation.path === 'chunk' &&
      failure.code === 'data_root_not_found' &&
      registration !== undefined &&
      this.headers.get(gateway) === registration
    )
      this.headers.delete(gateway);
  }

  private ensureHeader(gateway: string, operation: Operation): Promise<void> {
    const existing = this.headers.get(gateway);
    if (existing !== undefined) return existing;
    const pending = this.fetch(gateway, operation)
      .then(() => undefined)
      .catch((error: unknown) => {
        if (this.headers.get(gateway) === pending) this.headers.delete(gateway);
        throw error;
      });
    this.headers.set(gateway, pending);
    return pending;
  }

  private pause(delayMs: number): Promise<void> {
    const signal = this.controller.signal;
    return new Promise((resolve, reject) => {
      const finish = () => {
        clearTimeout(timeout);
        signal.removeEventListener('abort', finish);
        if (this.stopped) reject(this.stopped);
        else resolve();
      };
      const timeout = setTimeout(finish, delayMs);
      signal.addEventListener('abort', finish, { once: true });
      if (signal.aborted) finish();
    });
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
        redirect: 'error',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/plain, */*'
        },
        body: operation.body,
        signal: requestController.signal
      });
      const body = await boundedResponseText(response);
      if (
        !response.ok ||
        (operation.path === 'chunk' && response.status !== 200)
      )
        throw providerError(response.status, body);
      if (operation.validate && !operation.validate(body, response.status)) {
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
