import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import {
  CHAIN_PENDING_OPERATION_SIGNERS_TABLE,
  CHAIN_PENDING_OPERATIONS_TABLE
} from '@/constants';

/**
 * An identity join drafted by the gateway and signed by one of its two
 * wallets (the identity's and the joining one), held until the other signs,
 * then relayed to the chain. Its principal, signers and expiry are its typed
 * data's. It is held only if its role-0 wallet belongs to that identity
 * when it is posted, and a wallet may have created at most five pending
 * ones.
 */
@Entity(CHAIN_PENDING_OPERATIONS_TABLE)
@Index('chain_pending_operations_status_expiry_idx', ['status', 'expires_at'])
export class ChainPendingOperationEntity {
  /** The EIP-712 digest every signature signs (0x, 32 bytes). */
  @PrimaryColumn({ type: 'varchar', length: 66, nullable: false })
  readonly tx_id!: string;

  @Column({ type: 'varchar', length: 50, nullable: false })
  readonly op_type!: string;

  @Column({ type: 'varchar', length: 66, nullable: true, default: null })
  readonly principal!: string | null;

  /** The draft's unsigned envelope bytes (0x hex). */
  @Column({ type: 'mediumtext', nullable: false })
  readonly unsigned_hex!: string;

  /**
   * The draft's EIP-712 typed data (JSON), which the other wallets sign; it
   * hashes to tx_id.
   */
  @Column({ type: 'mediumtext', nullable: false })
  readonly typed_data_json!: string;

  @Column({ type: 'varchar', length: 50, nullable: false })
  readonly created_by!: string;

  /** Unix ms; the chain refuses the operation after it. */
  @Column({ type: 'bigint', nullable: false })
  readonly expires_at!: number;

  /**
   * PENDING, SUBMITTED, FAILED or CANCELLED (the API shows a PENDING one
   * past expires_at as EXPIRED). It moves only from PENDING, under the
   * row's lock; SUBMITTED goes back to PENDING only when the node surely
   * didn't take it, and to FAILED when the chain ran it and it failed, or
   * held it nowhere well past its expiry in the chain's time.
   */
  @Column({ type: 'varchar', length: 20, nullable: false })
  readonly status!: string;

  /**
   * The submit's result (JSON), always with its `outcome`: `accepted` (the
   * node's answer, and the chain's `tx` once a read asked), `unknown`
   * (`txId`, and `nodeTxId` when the node named another: while it is being
   * sent, and when the answer was lost; never sent again) or `refused` (the
   * node's `code`, the chain's result name, or `expired`). Until the chain
   * makes it final, reads ask it at most every 10 s, keeping the time of
   * the last ask in `checkedAt`.
   */
  @Column({ type: 'text', nullable: true, default: null })
  readonly result_json!: string | null;

  @Column({ type: 'text', nullable: true, default: null })
  readonly last_error!: string | null;

  @Column({ type: 'bigint', nullable: false })
  readonly created_at!: number;

  @Column({ type: 'bigint', nullable: false })
  readonly updated_at!: number;
}

/** One signature an operation needs, and the signature once given. */
@Entity(CHAIN_PENDING_OPERATION_SIGNERS_TABLE)
@Index('chain_pending_operation_signers_signer_idx', ['signer'])
export class ChainPendingOperationSignerEntity {
  @PrimaryColumn({ type: 'varchar', length: 66, nullable: false })
  readonly tx_id!: string;

  @PrimaryColumn({ type: 'int', nullable: false })
  readonly role!: number;

  @Column({ type: 'int', nullable: false })
  readonly key_type!: number;

  @Column({ type: 'varchar', length: 50, nullable: false })
  readonly signer!: string;

  /**
   * 65-byte signature (0x hex); null until given, and again once the
   * operation is withdrawn (signed_at stays).
   */
  @Column({ type: 'varchar', length: 140, nullable: true, default: null })
  readonly sig!: string | null;

  @Column({ type: 'bigint', nullable: true, default: null })
  readonly signed_at!: number | null;
}
