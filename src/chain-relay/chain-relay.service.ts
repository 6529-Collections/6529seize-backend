import { recoverAddress, TypedDataEncoder, TypedDataField } from 'ethers';
import {
  ChainGatewayClient,
  ChainGatewayError,
  chainGatewayClient
} from '@/chain-gateway/chain-gateway.client';
import {
  ChainSignature,
  ChainSubmitRequest,
  ChainSubmitResult,
  ChainTx
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
/** The one operation held here, and its code. */
export const IDENTITY_JOIN = 'IDENTITY_JOIN';
const IDENTITY_JOIN_CODE = 0x010f;
/** A join's roles: the identity's wallet, and the wallet joining it. */
const ROLE_SIGNER = 0;
const ROLE_JOINER = 4;

const MAX_UNSIGNED_BYTES = 128 * 1024;
const MAX_TYPED_DATA_CHARS = 64 * 1024;
const MAX_VALIDITY_MS = 7 * 24 * 60 * 60 * 1000 + 60_000;
/** How long a read waits for the chain to say what became of a submit. */
const CHAIN_CHECK_MS = 3_000;
/**
 * How long past its expiry an operation the chain doesn't hold is taken as
 * never landed: time for the blocks before its expiry to reach the node.
 */
const SETTLE_GRACE_MS = 5 * 60_000;

const TX_ID = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const SIGNATURE = /^0x[0-9a-f]{130}$/;
const HEX_BYTES = /^0x(?:[0-9a-f]{2})+$/;
const ZERO_WORD = '0x' + '0'.repeat(64);
/** A wallet's key id in a header: 12 zero bytes, then its address. */
const ADDRESS_WORD = /^0x0{24}([0-9a-f]{40})$/;

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

/** A relayed submit's answer: the node's, with its outcome. */
export type RelaySubmitResult = ChainSubmitResult & {
  readonly outcome: 'accepted';
};

type Gateway = Pick<ChainGatewayClient, 'submit' | 'getTx'>;

export interface ChainTypedData {
  readonly domain: Record<string, unknown>;
  readonly primaryType: string;
  readonly types: Record<string, TypedDataField[]>;
  readonly message: Record<string, unknown>;
}

/**
 * The EIP-712 digest of typed data (what a wallet signs), or null. Its
 * types must make its primaryType the struct signed, so what is read from
 * the message is what the digest is of.
 */
export function typedDataDigest(typedData: ChainTypedData): string | null {
  try {
    const { EIP712Domain: _domain, ...types } = typedData.types ?? {};
    if (TypedDataEncoder.getPrimaryType(types) !== typedData.primaryType) {
      return null;
    }
    return TypedDataEncoder.hash(
      typedData.domain as never,
      types,
      typedData.message
    ).toLowerCase();
  } catch {
    return null;
  }
}

/** What an identity join's typed data says, so what its signers sign. */
export interface JoinTerms {
  readonly principal: string;
  /** The identity's wallet, which signs it in role 0. */
  readonly signer: string;
  /** The wallet joining the identity, which signs it in role 4. */
  readonly joiner: string;
  /** Unix ms. */
  readonly expiresAt: number;
}

/** The EIP-712 types of the fields read from a join, as the node drafts it. */
const JOIN_FIELDS: Record<string, Record<string, string>> = {
  IdentityJoin: { header: 'TxHeader', body: 'IdentityJoinBody' },
  TxHeader: {
    principal: 'bytes32',
    keyType: 'uint8',
    keyId: 'bytes32',
    expiresAt: 'uint64'
  },
  IdentityJoinBody: { wallet: 'address' }
};

/**
 * The terms of an identity join a wallet signs, read from its typed data
 * (the node's draft: an IdentityJoin of a TxHeader and an IdentityJoinBody),
 * or null when it is no such join. The typed data hashes to the txId every
 * signature is of, so these are what was signed.
 */
export function joinTermsOf(typedData: ChainTypedData): JoinTerms | null {
  if (typedData?.primaryType !== 'IdentityJoin') return null;
  for (const [struct, fields] of Object.entries(JOIN_FIELDS)) {
    const members = typedData.types?.[struct];
    if (!Array.isArray(members)) return null;
    for (const [name, type] of Object.entries(fields)) {
      if (!members.some((it) => it?.name === name && it?.type === type)) {
        return null;
      }
    }
  }
  const { header, body } = (typedData.message ?? {}) as {
    header?: Record<string, unknown>;
    body?: Record<string, unknown>;
  };
  const text = (value: unknown) =>
    typeof value === 'string' ? value.trim().toLowerCase() : '';
  const principal = text(header?.principal);
  const keyId = ADDRESS_WORD.exec(text(header?.keyId));
  const joiner = text(body?.wallet);
  const expiresAt = Number(header?.expiresAt);
  if (
    !TX_ID.test(principal) ||
    principal === ZERO_WORD ||
    Number(header?.keyType) !== WALLET_KEY_TYPE ||
    !keyId ||
    !ADDRESS.test(joiner) ||
    !Number.isSafeInteger(expiresAt)
  ) {
    return null;
  }
  return { principal, signer: '0x' + keyId[1], joiner, expiresAt };
}

/** Whether an operation type, by name or code, is IDENTITY_JOIN. */
function isIdentityJoin(opType: string | number): boolean {
  const it = String(opType).trim();
  return (
    it.toUpperCase() === IDENTITY_JOIN || Number(it) === IDENTITY_JOIN_CODE
  );
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

/**
 * What a failed submit says of the transaction.
 * - `unknown`: it may have landed. The client throws outcome_unknown once
 *   the request may have reached the node (a 504, another 5xx, a timeout, a
 *   connection lost on the way, or an answer of another transaction than
 *   the drafted one, whose txId it carries). It is never sent again: that
 *   would be refused as a duplicate. The chain says what became of it.
 * - `refused`: the node refused the operation itself.
 * - `not_taken`: the node surely didn't take it (the client already sent it
 *   again after a 503, a 429 or a connection that never opened), the
 *   request never left this backend (the client not configured, or one of
 *   its own checks before sending), or the gateway refused this backend's
 *   access. It may be sent again.
 */
export interface SubmitFailure {
  readonly outcome: 'unknown' | 'refused' | 'not_taken';
  /** The draft's txId. */
  readonly txId: string;
  /** Another txId the node named, when it isn't the draft's. */
  readonly nodeTxId: string | null;
  /** The client's error code, when it gave one. */
  readonly code: string | null;
  readonly message: string;
}

export function submitFailure(error: unknown, txId: string): SubmitFailure {
  const message = (error as Error)?.message ?? String(error);
  const failure = (
    outcome: SubmitFailure['outcome'],
    code: string | null,
    named?: string
  ): SubmitFailure => {
    const other = named?.toLowerCase();
    return {
      outcome,
      txId,
      nodeTxId: other && other !== txId ? other : null,
      code,
      message
    };
  };
  if (!(error instanceof ChainGatewayError)) {
    // Not one the client classified: nothing says the request never left.
    return failure('unknown', null);
  }
  if (error.code === 'outcome_unknown') {
    return failure('unknown', error.code, error.txId);
  }
  // The client's own refusals before sending (no status): its settings, or
  // an argument it checks. Nothing reached the node.
  if (
    error.code === 'not_configured' ||
    (error.code === 'bad_request' && error.status === null)
  ) {
    return failure('not_taken', error.code);
  }
  if (OPERATION_REFUSALS.indexOf(error.code) >= 0) {
    return failure('refused', error.code, error.txId);
  }
  return failure('not_taken', error.code);
}

/** What the relay records and answers when a submit's outcome is unknown. */
function unknownMessage(failure: SubmitFailure): string {
  return failure.nodeTxId
    ? `The 6529 Network took ${failure.nodeTxId}, not ${failure.txId}: ask the chain for both (${failure.message})`
    : `The 6529 Network may have taken ${failure.txId}: ask the chain for it before sending it again (${failure.message})`;
}

/**
 * An operation's `result`, which always says its `outcome`: `accepted`
 * (the node took it: its answer, or what the chain holds as `tx`),
 * `unknown` (it may have landed) or `refused` (it didn't and won't: the
 * node's `code`, or `expired`).
 */
function acceptedResult(result: ChainSubmitResult): string {
  return JSON.stringify({ ...result, outcome: 'accepted' });
}

function unknownResult(txId: string, nodeTxId: string | null): string {
  return JSON.stringify({
    txId,
    outcome: 'unknown',
    ...(nodeTxId ? { nodeTxId } : {})
  });
}

function refusedResult(txId: string, code: string | null): string {
  return JSON.stringify({ txId, outcome: 'refused', code });
}

/** A held operation whose outcome is unknown, and the other txId it named. */
function unknownOf(op: PendingOperation): { nodeTxId: string | null } | null {
  if (op.status !== 'SUBMITTED' || !op.result_json) return null;
  try {
    const result = JSON.parse(op.result_json) as {
      outcome?: unknown;
      nodeTxId?: unknown;
    };
    if (result?.outcome !== 'unknown') return null;
    return {
      nodeTxId: typeof result.nodeTxId === 'string' ? result.nodeTxId : null
    };
  } catch {
    return null;
  }
}

/** Two first posts of one operation at once: the second insert lost. */
function isInsertRace(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'ER_DUP_ENTRY' || code === 'ER_LOCK_DEADLOCK';
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
  held: readonly { role: number; key_type: number; signer: string }[],
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
 * through the gateway's service lane, and holds an identity join, which
 * needs two wallets (the identity's and the joining one), until both have
 * signed. Each signature is checked against its signer before it is kept;
 * the chain checks everything again.
 */
export class ChainRelayService {
  constructor(
    private readonly gateway: Gateway = chainGatewayClient,
    private readonly db: ChainPendingOperationsDb = chainPendingOperationsDb,
    private readonly now: () => number = () => Date.now(),
    private readonly chainCheckMs: number = CHAIN_CHECK_MS
  ) {}

  /**
   * Relays a fully signed operation. `txId` is its draft's, which every
   * signer signed: the node's answer must be of it, and a failure names it.
   */
  async submit(request: RelaySubmitRequest): Promise<RelaySubmitResult> {
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
    let result: ChainSubmitResult;
    try {
      result = await this.gateway.submit({ ...request, txId });
    } catch (error) {
      return gatewayFailure(error, txId);
    }
    return { ...result, outcome: 'accepted' };
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

  /**
   * Checks a join to hold and returns its terms. Everything held is read
   * from the typed data, which hashes to the txId every signature is of;
   * a given field that says otherwise is refused, so no wallet can show
   * another wallet an operation that isn't what it would sign.
   */
  private checkInput(input: PendingOperationInput): JoinTerms {
    if (!TX_ID.test(lower(input.txId)))
      badRequest('txId must be 32 bytes of 0x hex');
    this.checkUnsigned(input.unsigned);
    if (JSON.stringify(input.typedData ?? null).length > MAX_TYPED_DATA_CHARS) {
      badRequest('typed_data is too large');
    }
    if (typedDataDigest(input.typedData) !== lower(input.txId)) {
      badRequest('typed_data does not hash to tx_id');
    }
    if (!isIdentityJoin(input.opType)) {
      badRequest('Only identity joins (IDENTITY_JOIN) are held here');
    }
    const join = joinTermsOf(input.typedData);
    if (!join) {
      badRequest(
        "typed_data is not an identity join's, signed by a wallet (keyType 1)"
      );
    }
    if (input.principal === null || lower(input.principal) !== join.principal) {
      badRequest("principal is not the typed data's");
    }
    if (input.expiresAt !== join.expiresAt) {
      badRequest("expires_at is not the typed data's");
    }
    const now = this.now();
    if (join.expiresAt <= now || join.expiresAt > now + MAX_VALIDITY_MS) {
      badRequest('expiresAt must be a time in the next seven days');
    }
    const given = input.required.map((it) => ({
      role: it.role,
      key_type: it.keyType,
      signer: lower(String(it.signer ?? ''))
    }));
    if (!sameSigners(joinSigners(join), given)) {
      badRequest(
        "required must be the typed data's two wallets: its signer in role 0, its joining wallet in role 4"
      );
    }
    return join;
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
   * Holds an identity join until both its wallets have signed. The creating
   * wallet must be one of them and have signed it. Creating it again with
   * more signatures adds them while it is pending. Relays it once both have
   * signed.
   */
  async createPending(
    input: PendingOperationInput,
    wallet: string
  ): Promise<PendingOperation> {
    const join = this.checkInput(input);
    const txId = lower(input.txId);
    const me = lower(wallet);
    const signers = joinSigners(join);
    const mine = signers.filter((it) => it.signer === me);
    if (!mine.length) {
      throw new ForbiddenException('You are not a signer of this operation');
    }
    const byRole = new Map(signers.map((it) => [it.role, it]));
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
    const hold = () =>
      this.db.executeNativeQueriesInTransaction(async (conn) => {
        const existing = await this.db.find(txId, conn);
        if (!existing) {
          await this.db.insert(
            {
              tx_id: txId,
              op_type: IDENTITY_JOIN,
              principal: join.principal,
              unsigned_hex: lower(input.unsigned),
              typed_data_json: JSON.stringify(input.typedData),
              created_by: me,
              expires_at: join.expiresAt,
              status: 'PENDING',
              result_json: null,
              last_error: null,
              created_at: now,
              updated_at: now,
              signers: signers.map((it) => ({
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
        // Its signers are the typed data's, as these are: the same txId.
        this.assertOpen(existing);
        for (const [role, sig] of Array.from(given.entries())) {
          const signer = existing.signers.find((it) => it.role === role);
          if (signer && !signer.sig) {
            await this.db.setSignature(txId, role, sig, now, conn);
          }
        }
      });
    try {
      await hold();
    } catch (error) {
      // Both wallets' first posts at once: both found no row, and one
      // insert lost (a duplicate key, or a deadlock on the gap both
      // locked). Once more, it finds the other's row and adds to it.
      if (!isInsertRace(error)) throw error;
      await hold();
    }
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

  /**
   * An operation. One sent with an unknown outcome is asked of the chain
   * first, so the answer is final once the chain can say.
   */
  async get(txId: string): Promise<PendingOperation> {
    const op = await this.getOrThrow(lower(txId));
    const unknown = unknownOf(op);
    return unknown ? await this.settle(op, unknown.nodeTxId) : op;
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
   * Asks the chain what became of an operation sent with an unknown
   * outcome (and of the other txId the node named, if any), each ask
   * bounded. Held there, in a block or in the pool, it was accepted. Held
   * nowhere once it has expired, with time for the blocks before its expiry
   * to arrive, it never landed and never will: FAILED. Otherwise, or when
   * the chain can't say, it stays unknown.
   */
  private async settle(
    op: PendingOperation,
    nodeTxId: string | null
  ): Promise<PendingOperation> {
    const ids = nodeTxId ? [op.tx_id, nodeTxId] : [op.tx_id];
    const answers = await Promise.all(ids.map((id) => this.chainTx(id)));
    const now = this.now();
    const held = answers.findIndex((it) => !!it);
    if (held >= 0) {
      await this.db.setStatus(
        op.tx_id,
        { from: 'SUBMITTED', to: 'SUBMITTED' },
        {
          result_json: JSON.stringify({
            txId: op.tx_id,
            outcome: 'accepted',
            ...(held > 0 ? { nodeTxId } : {}),
            tx: answers[held]
          })
        },
        now
      );
    } else if (
      answers.every((it) => it === null) &&
      op.expires_at + SETTLE_GRACE_MS <= now
    ) {
      await this.db.setStatus(
        op.tx_id,
        { from: 'SUBMITTED', to: 'FAILED' },
        {
          result_json: refusedResult(op.tx_id, 'expired'),
          last_error: `The 6529 Network never took ${op.tx_id}, and it has expired`
        },
        now
      );
    } else {
      return op;
    }
    return await this.getOrThrow(op.tx_id);
  }

  /**
   * The chain's place for a transaction: its answer, null when no block
   * or pool holds it, or undefined when it can't say in time.
   */
  private async chainTx(txId: string): Promise<ChainTx | null | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.gateway.getTx(txId),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), this.chainCheckMs);
        })
      ]);
    } catch (error) {
      if (error instanceof ChainGatewayError && error.code === 'not_held') {
        return null;
      }
      logger.warn(
        `[RELAY ${txId} CHAIN CHECK FAILED] ${(error as Error)?.message ?? error}`
      );
      return undefined;
    } finally {
      clearTimeout(timer);
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
   * again (a read settles it from the chain). Only an answer that the node
   * surely didn't take it moves it back to PENDING, for a retry.
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
    let result: ChainSubmitResult;
    try {
      result = await this.gateway.submit({
        unsigned: claimed.unsigned_hex,
        signatures: claimed.signers.map((it: PendingSigner) => ({
          role: it.role,
          keyType: it.key_type,
          sig: it.sig!
        })),
        // Checked as the typed data's digest when the operation was held.
        txId
      });
    } catch (error) {
      await this.recordFailure(submitFailure(error, txId));
      return await this.getOrThrow(txId);
    }
    try {
      await this.db.setStatus(
        txId,
        { from: 'SUBMITTED', to: 'SUBMITTED' },
        { result_json: acceptedResult(result) },
        this.now()
      );
    } catch (error) {
      // The node took it. The row still says the outcome is unknown, which
      // a read settles from the chain; the node's answer is kept here.
      logger.error(
        `[RELAY ${txId} ACCEPTED, NOT RECORDED] ${JSON.stringify(result)}: ${(error as Error)?.message ?? error}`
      );
    }
    return await this.getOrThrow(txId);
  }

  private async recordFailure(failure: SubmitFailure) {
    const { txId } = failure;
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
    } else if (failure.outcome === 'refused') {
      await this.db.setStatus(
        txId,
        { from: 'SUBMITTED', to: 'FAILED' },
        {
          result_json: refusedResult(txId, failure.code),
          last_error: failure.message
        },
        this.now()
      );
    } else {
      await this.db.setStatus(
        txId,
        { from: 'SUBMITTED', to: 'PENDING' },
        { last_error: failure.message },
        this.now()
      );
    }
  }
}

/** A join's two signers, as held: role 0 and role 4, both wallets. */
function joinSigners(join: JoinTerms) {
  return [
    { role: ROLE_SIGNER, key_type: WALLET_KEY_TYPE, signer: join.signer },
    { role: ROLE_JOINER, key_type: WALLET_KEY_TYPE, signer: join.joiner }
  ];
}

export const chainRelayService = new ChainRelayService();
