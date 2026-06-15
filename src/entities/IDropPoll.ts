import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import {
  DROP_POLL_OPTIONS_TABLE,
  DROP_POLL_VOTES_TABLE,
  DROP_POLLS_TABLE
} from '@/constants';

@Entity(DROP_POLLS_TABLE)
@Index('idx_drop_poll_drop_id_unique', ['drop_id'], { unique: true })
@Index('idx_drop_poll_wave_closing', ['wave_id', 'closing_time'])
export class DropPollEntity {
  @PrimaryColumn({ type: 'varchar', length: 100, nullable: false })
  readonly id!: string;

  @Index()
  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly wave_id!: string;

  @Index()
  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly drop_id!: string;

  @Column({ type: 'bigint', nullable: false })
  readonly closing_time!: number;

  @Column({ type: 'boolean', nullable: false })
  readonly multichoice!: boolean;

  @Column({ type: 'boolean', nullable: false, default: false })
  readonly anonymous!: boolean;

  @Column({ type: 'boolean', nullable: false, default: false })
  readonly only_droppers_can_respond!: boolean;
}

@Entity(DROP_POLL_OPTIONS_TABLE)
@Index('idx_drop_poll_option_wave_drop', ['wave_id', 'drop_id'])
export class DropPollOptionEntity {
  @PrimaryColumn({ type: 'varchar', length: 100, nullable: false })
  readonly poll_id!: string;

  @PrimaryColumn({ type: 'int', nullable: false })
  readonly option_no!: number;

  @Index()
  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly wave_id!: string;

  @Index()
  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly drop_id!: string;

  @Column({ type: 'text', nullable: false })
  readonly option_string!: string;
}

@Entity(DROP_POLL_VOTES_TABLE)
@Index('idx_drop_poll_vote_wave_drop', ['wave_id', 'drop_id'])
@Index('idx_drop_poll_vote_option_time', ['poll_id', 'option_no', 'vote_time'])
export class DropPollVoteEntity {
  @PrimaryColumn({ type: 'varchar', length: 100, nullable: false })
  readonly poll_id!: string;

  @Index()
  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly wave_id!: string;

  @Index()
  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly drop_id!: string;

  @PrimaryColumn({ type: 'int', nullable: false })
  readonly option_no!: number;

  @Column({ type: 'bigint', nullable: false })
  readonly vote_time!: number;

  @PrimaryColumn({ type: 'varchar', length: 100, nullable: false })
  readonly voter_id!: string;
}
