import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import {
  CHAIN_PENDING_OPERATION_SIGNERS_TABLE,
  CHAIN_PENDING_OPERATIONS_TABLE
} from '@/constants';

/**
 * A 6529 chain operation drafted by the gateway and signed by some of its
 * signers, held until the rest sign (an identity join needs the identity's
 * wallet and the joining wallet), then relayed to the chain.
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

  @Column({ type: 'varchar', length: 50, nullable: false })
  readonly created_by!: string;

  /** Unix ms; the chain refuses the operation after it. */
  @Column({ type: 'bigint', nullable: false })
  readonly expires_at!: number;

  /** PENDING, SUBMITTED, FAILED or CANCELLED. */
  @Column({ type: 'varchar', length: 20, nullable: false })
  readonly status!: string;

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

  /** 65-byte signature (0x hex); null until given. */
  @Column({ type: 'varchar', length: 140, nullable: true, default: null })
  readonly sig!: string | null;

  @Column({ type: 'bigint', nullable: true, default: null })
  readonly signed_at!: number | null;
}
