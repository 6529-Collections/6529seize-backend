import { recoverAddress, TypedDataEncoder, TypedDataField } from 'ethers';
import {
  ChainGatewayClient,
  ChainGatewayError,
  chainGatewayClient
} from '@/chain-gateway/chain-gateway.client';
import {
  ChainSignature,
  ChainSubmitRequest,
  ChainSubmitResult
} from '@/chain-gateway/chain-gateway.types';
import {
  BadRequestException,
  CustomApiCompliantException,
  ForbiddenException,
  NotFoundException
} from '@/exceptions';
import { Logger } from '@/logging';
import {
  chainPendingOperationsDb,
  ChainPendingOperationsDb,
  PendingOperation,
  PendingSigner
} from './chain-pending-operations.db';

const logger = Logger.get('CHAIN_RELAY');

/** keyType 1: an Ethereum wallet's secp256k1 signature over the txId. */
export const WALLET_KEY_TYPE = 1;
const MAX_UNSIGNED_BYTES = 128 * 1024;
const MAX_TYPED_DATA_CHARS = 64 * 1024;
const MAX_SIGNERS = 4;
const MAX_VALIDITY_MS = 7 * 24 * 60 * 60 * 1000 + 60_000;

const TX_ID = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const SIGNATURE = /^0x[0-9a-f]{130}$/;
const HEX_BYTES = /^0x(?:[0-9a-f]{2})+$/;

export interface PendingOperationInput {
  readonly txId: string;
  readonly opType: string | number;
  readonly principal: string | null;
  readonly unsigned: string;
  /** The draft's EIP-712 typed data: the other wallets sign it. */
  readonly typedData: ChainTypedData;
  /** Unix ms, the draft's expiresAt. */
  readonly expiresAt: number;
  /** The draft's signer list: who must sign, in which role. */
  readonly required: {
    readonly role: number;
    readonly keyType: number;
    readonly signer: string;
  }[];
  /** The signatures given so far (at least the creator's). */
  readonly signatures: ChainSignature[];
}

type Gateway = Pick<ChainGatewayClient, 'submit'>;

export interface ChainTypedData {
  readonly domain: Record<string, unknown>;
  readonly primaryType: string;
  readonly types: Record<string, TypedDataField[]>;
  readonly message: Record<string, unknown>;
}

/** The EIP-712 digest of typed data (what a wallet signs), or null. */
export function typedDataDigest(typedData: ChainTypedData): string | null {
  try {
    const { EIP712Domain: _domain, ...types } = typedData.types ?? {};
    return TypedDataEncoder.hash(
      typedData.domain as never,
      types,
      typedData.message
    ).toLowerCase();
  } catch {
    return null;
  }
}

function badRequest(message: string): never {
  throw new BadRequestException(message);
}

function lower(value: string): string {
  return value.trim().toLowerCase();
}

/** The wallet that signed `txId` with this 65-byte signature, or null. */
export function walletSignerOf(txId: string, sig: string): string | null {
  try {
    return recoverAddress(txId, sig).toLowerCase();
  } catch {
    return null;
  }
}

function gatewayFailure(error: unknown): never {
  if (error instanceof ChainGatewayError) {
    if (error.status !== null && error.status >= 400 && error.status < 500) {
      throw new CustomApiCompliantException(
        422,
        `The 6529 Network refused the operation: ${error.message}`,
        'CHAIN_REFUSED'
      );
    }
    throw new CustomApiCompliantException(
      502,
      `The 6529 Network could not be reached: ${error.message}`,
      'CHAIN_UNAVAILABLE'
    );
  }
  throw error;
}

/**
 * Relays operations people sign with their wallets to the 6529 chain
 * through the gateway's service lane, and holds an operation that needs more
 * than one wallet (an identity join: the identity's wallet and the joining
 * one) until every signer has signed. Each signature is checked against its
 * signer before it is kept; the chain checks everything again.
 */
export class ChainRelayService {
  constructor(
    private readonly gateway: Gateway = chainGatewayClient,
    private readonly db: ChainPendingOperationsDb = chainPendingOperationsDb,
    private readonly now: () => number = () => Date.now()
  ) {}

  /** Relays a fully signed operation. */
  async submit(request: ChainSubmitRequest): Promise<ChainSubmitResult> {
    if ('signed' in request) {
      if (!HEX_BYTES.test(lower(request.signed))) {
        badRequest('signed must be 0x hex bytes');
      }
    } else {
      this.checkUnsigned(request.unsigned);
      request.signatures.forEach((it) => this.checkSignatureShape(it));
    }
    try {
      return await this.gateway.submit(request);
    } catch (error) {
      return gatewayFailure(error);
    }
  }

  private checkUnsigned(unsigned: string) {
    const hex = lower(unsigned);
    if (!HEX_BYTES.test(hex) || (hex.length - 2) / 2 > MAX_UNSIGNED_BYTES) {
      badRequest(
        `unsigned must be 0x hex bytes, at most ${MAX_UNSIGNED_BYTES}`
      );
    }
  }

  private checkSignatureShape(signature: ChainSignature) {
    if (!Number.isInteger(signature.role) || signature.role < 0) {
      badRequest('A signature needs its role');
    }
    if (signature.keyType !== WALLET_KEY_TYPE) {
      badRequest('Only wallet signatures (keyType 1) are accepted here');
    }
    if (!SIGNATURE.test(lower(signature.sig))) {
      badRequest('A signature must be 65 bytes of 0x hex');
    }
  }

  private checkInput(input: PendingOperationInput) {
    if (!TX_ID.test(lower(input.txId)))
      badRequest('txId must be 32 bytes of 0x hex');
    this.checkUnsigned(input.unsigned);
    if (JSON.stringify(input.typedData ?? null).length > MAX_TYPED_DATA_CHARS) {
      badRequest('typed_data is too large');
    }
    if (typedDataDigest(input.typedData) !== lower(input.txId)) {
      badRequest('typed_data does not hash to tx_id');
    }
    if (input.principal !== null && !TX_ID.test(lower(input.principal))) {
      badRequest('principal must be 32 bytes of 0x hex, or null');
    }
    const now = this.now();
    if (
      !Number.isSafeInteger(input.expiresAt) ||
      input.expiresAt <= now ||
      input.expiresAt > now + MAX_VALIDITY_MS
    ) {
      badRequest('expiresAt must be a time in the next seven days');
    }
    if (!input.required.length || input.required.length > MAX_SIGNERS) {
      badRequest(`An operation needs 1 to ${MAX_SIGNERS} signers`);
    }
    const roles = new Set<number>();
    for (const it of input.required) {
      if (!Number.isInteger(it.role) || it.role < 0 || roles.has(it.role)) {
        badRequest('Each signer needs its own role');
      }
      roles.add(it.role);
      if (it.keyType !== WALLET_KEY_TYPE || !ADDRESS.test(lower(it.signer))) {
        badRequest('Each signer must be a wallet (keyType 1, 0x address)');
      }
    }
  }

  private checkSignature(
    txId: string,
    signer: { role: number; signer: string },
    signature: ChainSignature
  ) {
    this.checkSignatureShape(signature);
    if (walletSignerOf(txId, lower(signature.sig)) !== lower(signer.signer)) {
      badRequest(
        `The signature for role ${signature.role} is not ${signer.signer}'s signature of this operation`
      );
    }
  }

  /**
   * Holds an operation that needs more wallets' signatures. The creating
   * wallet must be one of its signers and have signed it. Creating it again
   * with more signatures adds them. Relays it once every signer has signed.
   */
  async createPending(
    input: PendingOperationInput,
    wallet: string
  ): Promise<PendingOperation> {
    this.checkInput(input);
    const txId = lower(input.txId);
    const me = lower(wallet);
    const required = input.required.map((it) => ({
      role: it.role,
      key_type: it.keyType,
      signer: lower(it.signer)
    }));
    const mine = required.filter((it) => it.signer === me);
    if (!mine.length) {
      throw new ForbiddenException('You are not a signer of this operation');
    }
    const byRole = new Map(required.map((it) => [it.role, it]));
    const given = new Map<number, string>();
    for (const signature of input.signatures) {
      const signer = byRole.get(signature.role);
      if (!signer) badRequest(`No signer has role ${signature.role}`);
      this.checkSignature(txId, signer, signature);
      given.set(signature.role, lower(signature.sig));
    }
    if (!mine.some((it) => given.has(it.role))) {
      badRequest('Sign the operation before sharing it');
    }
    const now = this.now();
    await this.db.executeNativeQueriesInTransaction(async (conn) => {
      const existing = await this.db.find(txId, conn);
      if (!existing) {
        await this.db.insert(
          {
            tx_id: txId,
            op_type: String(input.opType),
            principal: input.principal ? lower(input.principal) : null,
            unsigned_hex: lower(input.unsigned),
            typed_data_json: JSON.stringify(input.typedData),
            created_by: me,
            expires_at: input.expiresAt,
            status: 'PENDING',
            result_json: null,
            last_error: null,
            created_at: now,
            updated_at: now,
            signers: required.map((it) => ({
              ...it,
              sig: given.get(it.role) ?? null,
              signed_at: given.has(it.role) ? now : null
            }))
          },
          conn
        );
        return;
      }
      for (const [role, sig] of Array.from(given.entries())) {
        const signer = existing.signers.find((it) => it.role === role);
        if (signer && !signer.sig) {
          await this.db.setSignature(txId, role, sig, now, conn);
        }
      }
    });
    return await this.submitIfComplete(txId);
  }

  /** Adds one wallet's signature; relays the operation once complete. */
  async addSignature(
    txId: string,
    signature: ChainSignature,
    wallet: string
  ): Promise<PendingOperation> {
    const id = lower(txId);
    const op = await this.getOrThrow(id);
    this.assertOpen(op);
    const signer = op.signers.find((it) => it.role === signature.role);
    if (!signer) badRequest(`No signer has role ${signature.role}`);
    if (signer.signer !== lower(wallet)) {
      throw new ForbiddenException(
        `Role ${signature.role} is ${signer.signer}'s to sign`
      );
    }
    this.checkSignature(id, signer, signature);
    await this.db.executeNativeQueriesInTransaction((conn) =>
      this.db.setSignature(
        id,
        signature.role,
        lower(signature.sig),
        this.now(),
        conn
      )
    );
    return await this.submitIfComplete(id);
  }

  /** Relays a complete operation again (after the chain was unreachable). */
  async retry(txId: string, wallet: string): Promise<PendingOperation> {
    const op = await this.getOrThrow(lower(txId));
    this.assertParty(op, wallet);
    this.assertOpen(op);
    return await this.submitIfComplete(op.tx_id);
  }

  async cancel(txId: string, wallet: string): Promise<PendingOperation> {
    const op = await this.getOrThrow(lower(txId));
    this.assertParty(op, wallet);
    this.assertOpen(op);
    await this.db.setStatus(op.tx_id, 'CANCELLED', {}, this.now());
    return await this.getOrThrow(op.tx_id);
  }

  async get(txId: string): Promise<PendingOperation> {
    return await this.getOrThrow(lower(txId));
  }

  /** Operations waiting for this wallet's signature. */
  async awaiting(wallet: string): Promise<PendingOperation[]> {
    const ids = await this.db.awaiting(lower(wallet), this.now());
    const ops = await Promise.all(ids.map((id) => this.db.find(id)));
    return ops.filter((it): it is PendingOperation => !!it);
  }

  private async getOrThrow(txId: string): Promise<PendingOperation> {
    const op = await this.db.find(txId);
    if (!op) throw new NotFoundException(`No pending operation ${txId}`);
    return op;
  }

  private assertParty(op: PendingOperation, wallet: string) {
    const me = lower(wallet);
    if (op.created_by !== me && !op.signers.some((it) => it.signer === me)) {
      throw new ForbiddenException('You are not a signer of this operation');
    }
  }

  private assertOpen(op: PendingOperation) {
    if (op.status !== 'PENDING') {
      badRequest(`The operation is ${op.status.toLowerCase()}`);
    }
    if (op.expires_at <= this.now()) {
      badRequest('The operation has expired: draft it again');
    }
  }

  private async submitIfComplete(txId: string): Promise<PendingOperation> {
    const op = await this.getOrThrow(txId);
    if (op.status !== 'PENDING' || op.signers.some((it) => !it.sig)) {
      return op;
    }
    try {
      const result = await this.gateway.submit({
        unsigned: op.unsigned_hex,
        signatures: op.signers.map((it: PendingSigner) => ({
          role: it.role,
          keyType: it.key_type,
          sig: it.sig!
        }))
      });
      await this.db.setStatus(
        txId,
        'SUBMITTED',
        { result_json: JSON.stringify(result) },
        this.now()
      );
    } catch (error) {
      const refused =
        error instanceof ChainGatewayError &&
        error.status !== null &&
        error.status >= 400 &&
        error.status < 500;
      const message = (error as Error)?.message ?? String(error);
      logger.warn(
        `[RELAY ${txId} ${refused ? 'REFUSED' : 'FAILED'}] ${message}`
      );
      await this.db.setStatus(
        txId,
        refused ? 'FAILED' : 'PENDING',
        { last_error: message },
        this.now()
      );
    }
    return await this.getOrThrow(txId);
  }
}

export const chainRelayService = new ChainRelayService();
