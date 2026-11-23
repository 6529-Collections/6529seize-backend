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
  ApiErrorDetails,
  BadRequestException,
  CustomApiCompliantException,
  ForbiddenException,
  NotFoundException
} from '@/exceptions';
import { Logger } from '@/logging';
import { ConnectionWrapper } from '@/sql-executor';
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

/**
 * A signed operation to relay, with its draft's txId: the digest every
 * signer signed. The gateway client checks that the node's answer is of
 * this transaction.
 */
export type RelaySubmitRequest = ChainSubmitRequest & {
  readonly txId: string;
};

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

function isSigner(op: PendingOperation, wallet: string): boolean {
  const me = lower(wallet);
  return op.signers.some((it) => it.signer === me);
}

/**
 * Whether `wallet` may read the signatures an operation holds: only the
 * operation's own signers (for a join, the identity's wallet in role 0 and
 * the joining wallet in role 4), and only while it is pending and unexpired.
 * Anyone else holding a signature could finish the operation on the chain
 * themselves, even after a signer withdrew it.
 */
export function maySeeSignatures(
  op: PendingOperation,
  wallet: string,
  now: number
): boolean {
  return op.status === 'PENDING' && op.expires_at > now && isSigner(op, wallet);
}

/**
 * The codes in the client's REFUSALS that refuse the operation itself: it
 * wasn't taken and won't be as it is. The rest of that list is the gateway
 * refusing this backend's own access or request (unauthorized, forbidden,
 * bad_path, ...). That says nothing against the operation, and it wasn't
 * taken, so it may be sent again.
 */
const OPERATION_REFUSALS = [
  'inadmissible',
  'not_admitted',
  'bad_request',
  'too_large',
  'body_too_large',
  'head_too_large',
  'bad_body'
];

/** The client's words for an answer of another transaction than drafted. */
const TOOK_ANOTHER = /the node took (0x[0-9a-f]{64}), not 0x[0-9a-f]{64}/i;

/**
 * What a failed submit says of the transaction.
 * - `unknown`: it may have landed. The client throws outcome_unknown once
 *   the request may have reached the node (a 504, another 5xx, a timeout, a
 *   connection lost on the way), and an answer of another transaction than
 *   the drafted one means something landed. It is never sent again: that
 *   would be refused as a duplicate. Ask the chain for it.
 * - `refused`: the node refused the operation itself.
 * - `not_taken`: the node surely didn't take it (the client already sent it
 *   again after a 503, a 429 or a connection that never opened), or the
 *   gateway refused this backend's access. It may be sent again.
 */
export interface SubmitFailure {
  readonly outcome: 'unknown' | 'refused' | 'not_taken';
  /** The draft's txId. */
  readonly txId: string;
  /** Another txId the node named, when it isn't the draft's. */
  readonly nodeTxId: string | null;
  readonly message: string;
}

export function submitFailure(error: unknown, txId: string): SubmitFailure {
  const message = (error as Error)?.message ?? String(error);
  const failure = (
    outcome: SubmitFailure['outcome'],
    named?: string
  ): SubmitFailure => {
    const other = named?.toLowerCase();
    return {
      outcome,
      txId,
      nodeTxId: other && other !== txId ? other : null,
      message
    };
  };
  if (!(error instanceof ChainGatewayError)) {
    // Not one the client classified: nothing says the request never left.
    return failure('unknown');
  }
  const took = TOOK_ANOTHER.exec(message);
  if (error.code === 'outcome_unknown' || took) {
    return failure('unknown', took?.[1] ?? error.txId);
  }
  if (OPERATION_REFUSALS.indexOf(error.code) >= 0) {
    return failure('refused', error.txId);
  }
  return failure('not_taken');
}

/** What the relay records and answers when a submit's outcome is unknown. */
function unknownMessage(failure: SubmitFailure): string {
  return failure.nodeTxId
    ? `The 6529 Network took ${failure.nodeTxId}, not ${failure.txId}: ask the chain for both (${failure.message})`
    : `The 6529 Network may have taken ${failure.txId}: ask the chain for it before sending it again (${failure.message})`;
}

/** An operation's `result` while its outcome is unknown. */
function unknownResult(txId: string, nodeTxId: string | null): string {
  return JSON.stringify({
    txId,
    outcome: 'unknown',
    ...(nodeTxId ? { nodeTxId } : {})
  });
}

/**
 * A direct submit's failure as an API answer. Each carries `tx_id` and an
 * `outcome`: `refused` (422), `unknown` (502: it may have landed, so ask the
 * chain and don't send it again) or `not_taken` (502: it may be sent again).
 */
function gatewayFailure(error: unknown, txId: string): never {
  const failure = submitFailure(error, txId);
  const details: ApiErrorDetails = {
    tx_id: txId,
    outcome: failure.outcome,
    ...(failure.nodeTxId ? { node_tx_id: failure.nodeTxId } : {})
  };
  if (failure.outcome === 'refused') {
    throw new CustomApiCompliantException(
      422,
      `The 6529 Network refused the operation: ${failure.message}`,
      'CHAIN_REFUSED',
      details
    );
  }
  if (failure.outcome === 'unknown') {
    throw new CustomApiCompliantException(
      502,
      unknownMessage(failure),
      'CHAIN_OUTCOME_UNKNOWN',
      details
    );
  }
  throw new CustomApiCompliantException(
    502,
    `The 6529 Network could not be reached: ${failure.message}`,
    'CHAIN_UNAVAILABLE',
    details
  );
}

/** Whether a held signer list is the given one: same roles, key types, wallets. */
function sameSigners(
  held: readonly PendingSigner[],
  given: readonly { role: number; key_type: number; signer: string }[]
): boolean {
  return (
    held.length === given.length &&
    given.every((it) =>
      held.some(
        (h) =>
          h.role === it.role &&
          h.key_type === it.key_type &&
          h.signer === it.signer
      )
    )
  );
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

  /**
   * Relays a fully signed operation. `txId` is its draft's, which every
   * signer signed: the node's answer must be of it, and a failure names it.
   */
  async submit(request: RelaySubmitRequest): Promise<ChainSubmitResult> {
    const txId = lower(String(request.txId ?? ''));
    if (!TX_ID.test(txId)) badRequest('tx_id must be 32 bytes of 0x hex');
    if ('signed' in request) {
      if (!HEX_BYTES.test(lower(request.signed))) {
        badRequest('signed must be 0x hex bytes');
      }
    } else {
      this.checkUnsigned(request.unsigned);
      request.signatures.forEach((it) => this.checkSignatureShape(it));
    }
    try {
      return await this.gateway.submit({ ...request, txId });
    } catch (error) {
      return gatewayFailure(error, txId);
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
   * with more signatures adds them while it is pending. Relays it once every
   * signer has signed.
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
      // A withdrawn, sent or expired operation takes no more signatures.
      this.assertOpen(existing);
      // The signatures were checked against the given signer list, so it
      // must be the held one, or one could fill another wallet's role.
      if (!sameSigners(existing.signers, required)) {
        badRequest('The operation is held with other signers');
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
    // Checked and stored with the operation's row locked, so a signature
    // never lands on an operation a signer has just withdrawn.
    await this.db.executeNativeQueriesInTransaction(async (conn) => {
      const op = await this.lockedOrThrow(id, conn);
      this.assertOpen(op);
      const signer = op.signers.find((it) => it.role === signature.role);
      if (!signer) badRequest(`No signer has role ${signature.role}`);
      if (signer.signer !== lower(wallet)) {
        throw new ForbiddenException(
          `Role ${signature.role} is ${signer.signer}'s to sign`
        );
      }
      this.checkSignature(id, signer, signature);
      await this.db.setSignature(
        id,
        signature.role,
        lower(signature.sig),
        this.now(),
        conn
      );
    });
    return await this.submitIfComplete(id);
  }

  /**
   * Relays a complete operation again, after the node surely didn't take it
   * (the chain was unreachable). One whose outcome is unknown is SUBMITTED,
   * and is never sent again.
   */
  async retry(txId: string, wallet: string): Promise<PendingOperation> {
    return await this.submitIfComplete(lower(txId), (op) => {
      this.assertParty(op, wallet);
      this.assertOpen(op);
    });
  }

  /**
   * Withdraws a pending operation: from then on it is never sent and takes
   * no signatures, and the signatures it held are dropped.
   */
  async cancel(txId: string, wallet: string): Promise<PendingOperation> {
    const id = lower(txId);
    await this.db.executeNativeQueriesInTransaction(async (conn) => {
      const op = await this.lockedOrThrow(id, conn);
      this.assertParty(op, wallet);
      this.assertOpen(op);
      const moved = await this.db.setStatus(
        id,
        { from: 'PENDING', to: 'CANCELLED' },
        {},
        this.now(),
        conn
      );
      if (!moved) badRequest('The operation is no longer pending');
      await this.db.clearSignatures(id, conn);
    });
    return await this.getOrThrow(id);
  }

  async get(txId: string): Promise<PendingOperation> {
    return await this.getOrThrow(lower(txId));
  }

  /** Operations waiting for this wallet's signature. */
  async awaiting(wallet: string): Promise<PendingOperation[]> {
    const now = this.now();
    const ids = await this.db.awaiting(lower(wallet), now);
    const ops = await Promise.all(ids.map((id) => this.db.find(id)));
    return ops.filter(
      (it): it is PendingOperation =>
        !!it && it.status === 'PENDING' && it.expires_at > now
    );
  }

  private async getOrThrow(txId: string): Promise<PendingOperation> {
    const op = await this.db.find(txId);
    if (!op) throw new NotFoundException(`No pending operation ${txId}`);
    return op;
  }

  private async lockedOrThrow(
    txId: string,
    conn: ConnectionWrapper<any>
  ): Promise<PendingOperation> {
    const op = await this.db.find(txId, conn);
    if (!op) throw new NotFoundException(`No pending operation ${txId}`);
    return op;
  }

  /** A party is one of the operation's signers; its creator is one too. */
  private assertParty(op: PendingOperation, wallet: string) {
    if (op.created_by !== lower(wallet) && !isSigner(op, wallet)) {
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

  /**
   * Sends an operation once every signer has signed, and at most once.
   *
   * A withdrawn join is never sent. The operation is read with its row
   * locked (select ... for update) and moved from PENDING to SUBMITTED in
   * that same transaction, before anything goes to the gateway; a cancel
   * takes the same lock and moves it only from PENDING. Whichever locks the
   * row first wins. A cancel first, and this finds it CANCELLED and sends
   * nothing. This first, and the cancel finds it SUBMITTED and is refused.
   * The same claim keeps two requests that complete it at once from both
   * sending it. While it is being sent it stays SUBMITTED with an unknown
   * outcome, so a process that dies mid-send never leaves it to be sent
   * again. Only an answer that the node surely didn't take it moves it back
   * to PENDING, for a retry.
   *
   * `check` runs on the locked operation first, and may refuse it.
   */
  private async submitIfComplete(
    txId: string,
    check: (op: PendingOperation) => void = () => undefined
  ): Promise<PendingOperation> {
    const claimed = await this.db.executeNativeQueriesInTransaction(
      async (conn) => {
        const op = await this.lockedOrThrow(txId, conn);
        check(op);
        if (
          op.status !== 'PENDING' ||
          op.expires_at <= this.now() ||
          op.signers.some((it) => !it.sig)
        ) {
          return null;
        }
        const moved = await this.db.setStatus(
          txId,
          { from: 'PENDING', to: 'SUBMITTED' },
          { result_json: unknownResult(txId, null) },
          this.now(),
          conn
        );
        return moved ? op : null;
      }
    );
    if (!claimed) return await this.getOrThrow(txId);
    try {
      const result = await this.gateway.submit({
        unsigned: claimed.unsigned_hex,
        signatures: claimed.signers.map((it: PendingSigner) => ({
          role: it.role,
          keyType: it.key_type,
          sig: it.sig!
        })),
        // Checked as the typed data's digest when the operation was held.
        txId
      });
      await this.db.setStatus(
        txId,
        { from: 'SUBMITTED', to: 'SUBMITTED' },
        { result_json: JSON.stringify(result) },
        this.now()
      );
    } catch (error) {
      const failure = submitFailure(error, txId);
      logger.warn(
        `[RELAY ${txId} ${failure.outcome.toUpperCase()}] ${failure.message}`
      );
      if (failure.outcome === 'unknown') {
        await this.db.setStatus(
          txId,
          { from: 'SUBMITTED', to: 'SUBMITTED' },
          {
            result_json: unknownResult(txId, failure.nodeTxId),
            last_error: unknownMessage(failure)
          },
          this.now()
        );
      } else {
        await this.db.setStatus(
          txId,
          {
            from: 'SUBMITTED',
            to: failure.outcome === 'refused' ? 'FAILED' : 'PENDING'
          },
          { last_error: failure.message },
          this.now()
        );
      }
    }
    return await this.getOrThrow(txId);
  }
}

export const chainRelayService = new ChainRelayService();
