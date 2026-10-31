import {
  Column,
  Entity,
  Index,
  PrimaryColumn,
  PrimaryGeneratedColumn
} from 'typeorm';
import {
  E2EE_BACKUP_CHUNKS_TABLE,
  E2EE_BACKUPS_TABLE,
  E2EE_BLOB_CHUNKS_TABLE,
  E2EE_BLOBS_TABLE,
  E2EE_CIPHERTEXT_OBJECTS_TABLE,
  E2EE_DEVICES_TABLE,
  E2EE_GROUP_EPOCHS_TABLE,
  E2EE_GROUP_ROSTER_TABLE,
  E2EE_GROUPS_TABLE,
  E2EE_KEY_PACKAGES_TABLE,
  E2EE_LOG_TABLE,
  E2EE_PUSH_THROTTLE_TABLE,
  E2EE_RATE_COUNTERS_TABLE,
  E2EE_REPORT_ACCESS_LOG_TABLE,
  E2EE_REPORTS_TABLE,
  E2EE_WELCOME_DELIVERIES_TABLE,
  E2EE_WELCOMES_TABLE
} from '@/constants/db-tables';

// End-to-end encrypted DMs and groups (D109). Every byte column holds
// ciphertext or opaque MLS bytes produced by clients; the server never stores
// plaintext, private keys or MLS group secrets. Hex values are lowercase and
// 0x-prefixed. Times ending in `_at` are unix milliseconds unless the column
// name says otherwise (grant fields are unix seconds, as signed).

/** A device key (MLS Ed25519 signature key) authorized by a wallet grant. */
@Entity(E2EE_DEVICES_TABLE)
@Index('e2ee_devices_profile_idx', ['profile_id', 'revoked_at'])
@Index('e2ee_devices_revoked_idx', ['revoked_at'])
@Index('e2ee_devices_grant_idx', ['grant_id'])
export class E2eeDeviceEntity {
  @PrimaryColumn({ type: 'varchar', length: 66 })
  readonly device_key!: string;

  @Column({ type: 'varchar', length: 100 })
  readonly profile_id!: string;

  @Column({ type: 'varchar', length: 42 })
  readonly wallet!: string;

  @Column({ type: 'int' })
  readonly ciphersuite!: number;

  @Column({ type: 'bigint' })
  readonly issued_at_seconds!: number;

  @Column({ type: 'bigint' })
  readonly expires_at_seconds!: number;

  @Column({ type: 'varchar', length: 64 })
  readonly origin!: string;

  @Column({ type: 'varchar', length: 66 })
  readonly grant_id!: string;

  @Column({ type: 'text' })
  readonly wallet_signature!: string;

  @Column({ type: 'varchar', length: 16 })
  readonly verified_via!: string;

  @Column({ type: 'varchar', length: 48 })
  readonly label!: string;

  @Column({ type: 'varchar', length: 16 })
  readonly platform!: string;

  @Column({ type: 'bigint' })
  readonly created_at!: number;

  @Column({ type: 'bigint' })
  readonly updated_at!: number;

  @Column({ type: 'bigint', nullable: true, default: null })
  readonly last_seen_at!: number | null;

  @Column({ type: 'bigint', nullable: true, default: null })
  readonly revoked_at!: number | null;

  @Column({ type: 'varchar', length: 66, nullable: true, default: null })
  readonly revoker_device_key!: string | null;

  @Column({ type: 'bigint', nullable: true, default: null })
  readonly revocation_signed_at_seconds!: number | null;

  @Column({ type: 'varchar', length: 130, nullable: true, default: null })
  readonly revocation_signature!: string | null;

  // Combined sign-in grant (NC8): the exact SIWE message the wallet signed;
  // then grant_id is its EIP-191 hash and wallet_signature signs it. Null
  // for EIP-712 MlsDeviceGrant grants.
  @Column({ type: 'text', nullable: true, default: null })
  readonly grant_message!: string | null;
}

/** Uploaded MLS KeyPackages. One-time rows are deleted when claimed. */
@Entity(E2EE_KEY_PACKAGES_TABLE)
@Index('e2ee_key_packages_device_idx', ['device_key', 'last_resort', 'id'])
@Index('e2ee_key_packages_expiry_idx', ['expires_at_seconds'])
export class E2eeKeyPackageEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  readonly id!: number;

  @Column({ type: 'varchar', length: 66 })
  readonly device_key!: string;

  @Column({ type: 'blob' })
  readonly data!: Buffer;

  @Column({ type: 'boolean', default: false })
  readonly last_resort!: boolean;

  @Column({ type: 'bigint' })
  readonly expires_at_seconds!: number;

  @Column({ type: 'bigint' })
  readonly created_at!: number;
}

/** The delivery-service view of a group: handle, current epoch and key. */
@Entity(E2EE_GROUPS_TABLE)
export class E2eeGroupEntity {
  @PrimaryColumn({ type: 'varchar', length: 66 })
  readonly group_handle!: string;

  @Column({ type: 'bigint' })
  readonly epoch!: number;

  @Column({ type: 'varchar', length: 66 })
  readonly commit_key!: string;

  @Column({ type: 'bigint' })
  readonly last_seq!: number;

  @Column({ type: 'varchar', length: 100 })
  readonly created_by_profile_id!: string;

  @Column({ type: 'bigint' })
  readonly created_at!: number;

  @Column({ type: 'bigint' })
  readonly updated_at!: number;
}

/** Commit key per epoch. The primary key makes each epoch's key immutable. */
@Entity(E2EE_GROUP_EPOCHS_TABLE)
export class E2eeGroupEpochEntity {
  @PrimaryColumn({ type: 'varchar', length: 66 })
  readonly group_handle!: string;

  @PrimaryColumn({ type: 'bigint' })
  readonly epoch!: number;

  @Column({ type: 'varchar', length: 66 })
  readonly commit_key!: string;

  @Column({ type: 'bigint' })
  readonly created_at!: number;
}

/**
 * Delivery roster windows. A device reads items whose epoch is in
 * [joined_epoch, removed_epoch). A device that rejoins gets a new row.
 */
@Entity(E2EE_GROUP_ROSTER_TABLE)
@Index('e2ee_group_roster_group_idx', ['group_handle', 'removed_epoch'])
@Index('e2ee_group_roster_device_idx', ['device_key', 'removed_epoch'])
@Index('e2ee_group_roster_profile_idx', ['profile_id', 'removed_epoch'])
export class E2eeGroupRosterEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  readonly id!: number;

  @Column({ type: 'varchar', length: 66 })
  readonly group_handle!: string;

  @Column({ type: 'varchar', length: 66 })
  readonly device_key!: string;

  @Column({ type: 'varchar', length: 100 })
  readonly profile_id!: string;

  @Column({ type: 'bigint' })
  readonly joined_epoch!: number;

  @Column({ type: 'bigint', nullable: true, default: null })
  readonly removed_epoch!: number | null;

  @Column({ type: 'bigint' })
  readonly added_at!: number;

  @Column({ type: 'bigint', nullable: true, default: null })
  readonly removed_at!: number | null;

  /** commit | leave (own proposal) | revoke | repair */
  @Column({ type: 'varchar', length: 16, nullable: true, default: null })
  readonly removal_kind!: string | null;
}

/**
 * The ordered group log: key-change entries and application messages share
 * one sequence per group. `commit_epoch` is set only for commits, so the
 * unique index enforces first-commit-wins per (group, epoch) in the database.
 */
@Entity(E2EE_LOG_TABLE)
@Index('e2ee_log_commit_epoch_uq', ['group_handle', 'commit_epoch'], {
  unique: true
})
@Index('e2ee_log_group_epoch_idx', ['group_handle', 'item_type', 'epoch'])
@Index('e2ee_log_retention_idx', ['item_type', 'created_at'])
export class E2eeLogEntity {
  @PrimaryColumn({ type: 'varchar', length: 66 })
  readonly group_handle!: string;

  @PrimaryColumn({ type: 'bigint' })
  readonly seq!: number;

  @Column({ type: 'varchar', length: 8 })
  readonly item_type!: string;

  @Column({ type: 'bigint' })
  readonly epoch!: number;

  // int rather than tinyint: the API type caster reads TINY as boolean.
  @Column({ type: 'int', unsigned: true, nullable: true, default: null })
  readonly kind!: number | null;

  @Column({ type: 'bigint', nullable: true, default: null })
  readonly commit_epoch!: number | null;

  @Column({ type: 'mediumblob' })
  readonly data!: Buffer;

  @Column({ type: 'int', unsigned: true })
  readonly padded_len!: number;

  @Column({ type: 'varchar', length: 66, nullable: true, default: null })
  readonly entry_hash!: string | null;

  @Column({ type: 'varchar', length: 66, nullable: true, default: null })
  readonly epoch_commitment!: string | null;

  @Column({ type: 'varchar', length: 66, nullable: true, default: null })
  readonly next_commit_key!: string | null;

  @Column({ type: 'varchar', length: 130, nullable: true, default: null })
  readonly signature!: string | null;

  @Column({ type: 'mediumtext', nullable: true, default: null })
  readonly roster_add!: string | null;

  @Column({ type: 'mediumtext', nullable: true, default: null })
  readonly roster_remove!: string | null;

  @Column({ type: 'varchar', length: 16, nullable: true, default: null })
  readonly epoch_fp!: string | null;

  @Column({ type: 'varchar', length: 66 })
  readonly sender_device_key!: string;

  @Column({ type: 'varchar', length: 100 })
  readonly sender_profile_id!: string;

  @Column({ type: 'bigint' })
  readonly created_at!: number;
}

/** MLS Welcome bytes, stored once per commit. */
@Entity(E2EE_WELCOMES_TABLE)
@Index('e2ee_welcomes_created_idx', ['created_at'])
export class E2eeWelcomeEntity {
  @PrimaryColumn({ type: 'varchar', length: 34 })
  readonly id!: string;

  @Column({ type: 'varchar', length: 66 })
  readonly group_handle!: string;

  @Column({ type: 'bigint' })
  readonly epoch!: number;

  @Column({ type: 'mediumblob' })
  readonly data!: Buffer;

  @Column({ type: 'mediumblob', nullable: true, default: null })
  readonly ratchet_tree!: Buffer | null;

  @Column({ type: 'varchar', length: 100 })
  readonly added_by_profile_id!: string;

  @Column({ type: 'varchar', length: 66 })
  readonly added_by_device_key!: string;

  @Column({ type: 'bigint' })
  readonly created_at!: number;
}

/** One pending delivery of a welcome to a target device. */
@Entity(E2EE_WELCOME_DELIVERIES_TABLE)
@Index('e2ee_welcome_deliveries_device_idx', ['device_key', 'created_at'])
@Index('e2ee_welcome_deliveries_created_idx', ['created_at'])
export class E2eeWelcomeDeliveryEntity {
  @PrimaryColumn({ type: 'varchar', length: 34 })
  readonly welcome_id!: string;

  @PrimaryColumn({ type: 'varchar', length: 66 })
  readonly device_key!: string;

  @Column({ type: 'varchar', length: 100 })
  readonly profile_id!: string;

  @Column({ type: 'bigint' })
  readonly created_at!: number;
}

/** Encrypted attachment metadata. Keys stay inside MLS messages. */
@Entity(E2EE_BLOBS_TABLE)
@Index('e2ee_blobs_created_idx', ['complete', 'created_at'])
@Index('e2ee_blobs_group_idx', ['group_handle'])
@Index('e2ee_blobs_uploader_idx', ['uploader_profile_id', 'created_at'])
export class E2eeBlobEntity {
  @PrimaryColumn({ type: 'varchar', length: 34 })
  readonly blob_id!: string;

  @Column({ type: 'varchar', length: 66 })
  readonly group_handle!: string;

  @Column({ type: 'varchar', length: 66 })
  readonly uploader_device_key!: string;

  @Column({ type: 'varchar', length: 100 })
  readonly uploader_profile_id!: string;

  @Column({ type: 'bigint' })
  readonly size!: number;

  @Column({ type: 'int', unsigned: true })
  readonly chunk_count!: number;

  @Column({ type: 'boolean', default: false })
  readonly complete!: boolean;

  @Column({ type: 'bigint' })
  readonly created_at!: number;

  @Column({ type: 'bigint', nullable: true, default: null })
  readonly completed_at!: number | null;

  /**
   * Where the chunk bytes live (`mysql` or `s3`), fixed at creation and
   * changed only by the S3 migration. Rows from before S3 storage are MySQL.
   */
  @Column({ type: 'varchar', length: 16, default: 'mysql' })
  readonly storage!: string;

  /**
   * The exact place the bytes were written (`s3://<bucket>/<prefix>` for
   * S3, null for MySQL). The API reads and deletes a blob only at this
   * location, so a settings change can never point it at the wrong objects.
   */
  @Column({ type: 'varchar', length: 255, nullable: true, default: null })
  readonly storage_location!: string | null;
}

/**
 * Chunk sizes of an encrypted attachment, plus the ciphertext bytes when the
 * blob's storage is MySQL (empty for blobs stored in S3).
 */
@Entity(E2EE_BLOB_CHUNKS_TABLE)
export class E2eeBlobChunkEntity {
  @PrimaryColumn({ type: 'varchar', length: 34 })
  readonly blob_id!: string;

  @PrimaryColumn({ type: 'int', unsigned: true })
  readonly chunk_index!: number;

  @Column({ type: 'mediumblob' })
  readonly data!: Buffer;

  @Column({ type: 'int', unsigned: true })
  readonly size!: number;

  @Column({ type: 'bigint' })
  readonly created_at!: number;
}

/**
 * A recipient's report of a decrypted message (severe or illegal harm only).
 * The reporter discloses the exact body and the sender's inner signature;
 * nothing else is decrypted. Only the trust and safety group reads these
 * rows; they never enter the AI moderation pipeline or the wave moderation
 * queue, and retention deletes them after 180 days unless `on_hold`.
 */
@Entity(E2EE_REPORTS_TABLE)
@Index('e2ee_reports_created_idx', ['created_at'])
@Index('e2ee_reports_sender_idx', ['sender_profile_id'])
export class E2eeReportEntity {
  @PrimaryColumn({ type: 'varchar', length: 34 })
  readonly id!: string;

  @Column({ type: 'varchar', length: 66 })
  readonly group_handle!: string;

  @Column({ type: 'bigint' })
  readonly epoch!: number;

  @Column({ type: 'mediumblob' })
  readonly body!: Buffer;

  @Column({ type: 'varchar', length: 130 })
  readonly signature!: string;

  @Column({ type: 'varchar', length: 66 })
  readonly sender_device_key!: string;

  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly sender_profile_id!: string | null;

  @Column({ type: 'varchar', length: 66 })
  readonly reporter_device_key!: string;

  @Column({ type: 'varchar', length: 100 })
  readonly reporter_profile_id!: string;

  @Column({ type: 'varchar', length: 64 })
  readonly reason!: string;

  @Column({ type: 'text', nullable: true, default: null })
  readonly notes!: string | null;

  @Column({ type: 'boolean' })
  readonly verified!: boolean;

  @Column({ type: 'bigint' })
  readonly created_at!: number;

  /** Set by trust and safety to keep the report past retention. */
  @Column({ type: 'boolean', default: false })
  readonly on_hold!: boolean;
}

/**
 * One trust-and-safety read or change of reported messages. Holds ids only,
 * never message content.
 */
@Entity(E2EE_REPORT_ACCESS_LOG_TABLE)
@Index('e2ee_report_access_viewer_idx', ['viewer_profile_id', 'created_at'])
export class E2eeReportAccessEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  readonly id!: number;

  @Column({ type: 'varchar', length: 100 })
  readonly viewer_profile_id!: string;

  /** `list`, `read`, `hold` or `release`. */
  @Column({ type: 'varchar', length: 16 })
  readonly action!: string;

  /** Comma-separated report ids the action returned or changed. */
  @Column({ type: 'text' })
  readonly report_ids!: string;

  @Column({ type: 'bigint' })
  readonly created_at!: number;
}

/** Last content-free wake per (profile, group); at most one per 60 s. */
@Entity(E2EE_PUSH_THROTTLE_TABLE)
@Index('e2ee_push_throttle_sent_idx', ['last_sent_at'])
export class E2eePushThrottleEntity {
  @PrimaryColumn({ type: 'varchar', length: 100 })
  readonly profile_id!: string;

  @PrimaryColumn({ type: 'varchar', length: 66 })
  readonly group_handle!: string;

  @Column({ type: 'bigint' })
  readonly last_sent_at!: number;
}

/** Fixed-window rate counters for E2EE endpoints. */
@Entity(E2EE_RATE_COUNTERS_TABLE)
@Index('e2ee_rate_counters_window_idx', ['window_start'])
export class E2eeRateCounterEntity {
  @PrimaryColumn({ type: 'varchar', length: 200 })
  readonly counter_key!: string;

  @Column({ type: 'bigint' })
  readonly window_start!: number;

  @Column({ type: 'int', unsigned: true })
  readonly hits!: number;
}

/**
 * One generation of a profile's encrypted message-history backup. The client
 * encrypts everything under a random backup key; `envelope` holds that key
 * wrapped by the user's recovery method and is opaque to the server. A
 * profile has at most one active generation and at most one pending one
 * (being uploaded before it replaces the active one).
 */
@Entity(E2EE_BACKUPS_TABLE)
@Index('e2ee_backups_profile_idx', ['profile_id', 'active'])
@Index('e2ee_backups_pending_idx', ['active', 'created_at'])
export class E2eeBackupEntity {
  @PrimaryColumn({ type: 'varchar', length: 34 })
  readonly backup_id!: string;

  @Column({ type: 'varchar', length: 100 })
  readonly profile_id!: string;

  @Column({ type: 'blob' })
  readonly envelope!: Buffer;

  @Column({ type: 'boolean', default: false })
  readonly active!: boolean;

  /** Next chunk sequence number (server assigned, starts at 1). */
  @Column({ type: 'int', unsigned: true })
  readonly next_seq!: number;

  @Column({ type: 'int', unsigned: true })
  readonly chunk_count!: number;

  /** Ciphertext bytes of the generation's chunks. */
  @Column({ type: 'bigint' })
  readonly size!: number;

  @Column({ type: 'varchar', length: 66 })
  readonly created_by_device_key!: string;

  @Column({ type: 'bigint' })
  readonly created_at!: number;

  @Column({ type: 'bigint' })
  readonly updated_at!: number;

  @Column({ type: 'bigint', nullable: true, default: null })
  readonly activated_at!: number | null;
}

/** Metadata of one backup ciphertext chunk; bytes live in the object store. */
@Entity(E2EE_BACKUP_CHUNKS_TABLE)
@Index('e2ee_backup_chunks_profile_idx', ['profile_id'])
export class E2eeBackupChunkEntity {
  @PrimaryColumn({ type: 'varchar', length: 34 })
  readonly backup_id!: string;

  @PrimaryColumn({ type: 'int', unsigned: true })
  readonly seq!: number;

  @Column({ type: 'varchar', length: 100 })
  readonly profile_id!: string;

  @Column({ type: 'int', unsigned: true })
  readonly size!: number;

  @Column({ type: 'varchar', length: 200 })
  readonly object_key!: string;

  @Column({ type: 'varchar', length: 66 })
  readonly uploader_device_key!: string;

  @Column({ type: 'bigint' })
  readonly created_at!: number;
}

/**
 * MySQL implementation of the E2EE ciphertext object store: opaque client
 * ciphertext addressed by key. An S3 implementation can replace it behind
 * the same interface without changing the API.
 */
@Entity(E2EE_CIPHERTEXT_OBJECTS_TABLE)
export class E2eeCiphertextObjectEntity {
  @PrimaryColumn({ type: 'varchar', length: 200 })
  readonly object_key!: string;

  @Column({ type: 'mediumblob' })
  readonly data!: Buffer;

  @Column({ type: 'bigint' })
  readonly created_at!: number;
}
