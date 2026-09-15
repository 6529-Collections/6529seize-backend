import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn
} from 'typeorm';
import {
  MENTION_ALIASES_TABLE,
  MENTION_ALIAS_MEMBERS_TABLE
} from '@/constants';
import { Time } from '@/time';

@Entity(MENTION_ALIASES_TABLE)
@Index(
  'uq_mention_alias_owner_name',
  ['owner_profile_id', 'normalized_alias'],
  {
    unique: true
  }
)
export class MentionAliasEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  id!: string;

  @Column({ type: 'varchar', length: 100 })
  owner_profile_id!: string;

  @Column({ type: 'varchar', length: 15 })
  alias!: string;

  @Column({ type: 'varchar', length: 15 })
  normalized_alias!: string;

  @CreateDateColumn()
  created_at?: Time;

  @UpdateDateColumn()
  updated_at?: Time;
}

@Entity(MENTION_ALIAS_MEMBERS_TABLE)
@Index('idx_mention_alias_member_profile', ['member_profile_id'])
export class MentionAliasMemberEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  alias_id!: string;

  @PrimaryColumn({ type: 'varchar', length: 100 })
  member_profile_id!: string;

  @Column({ type: 'int', unsigned: true })
  position!: number;
}
