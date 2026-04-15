import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { USER_GROUPS_TABLE } from '@/constants';

export enum GroupTdhInclusionStrategy {
  TDH = 'TDH',
  XTDH = 'XTDH',
  BOTH = 'BOTH'
}

const IS_PURE_PROFILE_GROUP_EXPRESSION = `
  profile_group_id IS NOT NULL
  AND excluded_profile_group_id IS NULL
  AND tdh_min IS NULL
  AND tdh_max IS NULL
  AND level_min IS NULL
  AND level_max IS NULL
  AND rep_min IS NULL
  AND rep_max IS NULL
  AND cic_min IS NULL
  AND cic_max IS NULL
  AND cic_user IS NULL
  AND rep_user IS NULL
  AND rep_category IS NULL
  AND is_beneficiary_of_grant_id IS NULL
  AND COALESCE(owns_meme, 0) = 0
  AND COALESCE(owns_gradient, 0) = 0
  AND COALESCE(owns_nextgen, 0) = 0
  AND COALESCE(owns_lab, 0) = 0
`;

@Entity(USER_GROUPS_TABLE)
@Index(['id', 'visible'])
@Index(['profile_group_id', 'visible', 'id'])
@Index(['excluded_profile_group_id', 'id'])
export class UserGroupEntity {
  @PrimaryColumn({ type: 'varchar', length: 200, nullable: false })
  readonly id!: string;
  @Column({ type: 'varchar', length: 200, nullable: false })
  readonly name!: string;
  @Column({ type: 'bigint', nullable: true })
  readonly cic_min!: number | null;
  @Column({ type: 'bigint', nullable: true })
  readonly cic_max!: number | null;
  @Column({ type: 'varchar', length: 100, nullable: true })
  readonly cic_user!: string | null;
  @Column({ type: 'varchar', length: 20, nullable: true })
  readonly cic_direction!: FilterDirection | null;
  @Column({ type: 'bigint', nullable: true })
  readonly rep_min!: number | null;
  @Column({ type: 'bigint', nullable: true })
  readonly rep_max!: number | null;
  @Column({ type: 'varchar', length: 100, nullable: true })
  readonly rep_user!: string | null;
  @Column({ type: 'varchar', length: 20, nullable: true })
  readonly rep_direction!: FilterDirection | null;
  @Column({ type: 'varchar', length: 200, nullable: true })
  readonly rep_category!: string | null;
  @Column({ type: 'bigint', nullable: true })
  readonly tdh_min!: number | null;
  @Column({ type: 'bigint', nullable: true })
  readonly tdh_max!: number | null;
  @Column({
    type: 'varchar',
    length: 20,
    nullable: false,
    default: GroupTdhInclusionStrategy.TDH
  })
  readonly tdh_inclusion_strategy!: GroupTdhInclusionStrategy;
  @Column({ type: 'bigint', nullable: true })
  readonly level_min!: number | null;
  @Column({ type: 'bigint', nullable: true })
  readonly level_max!: number | null;
  @Column({ type: 'datetime', nullable: false })
  readonly created_at!: Date;
  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly created_by!: string;
  @Column({ type: 'boolean', nullable: false })
  @Index()
  readonly visible!: boolean;
  @Column({ type: 'boolean' })
  readonly owns_meme!: boolean | null;
  @Column({ type: 'json', nullable: true })
  readonly owns_meme_tokens!: string | null;
  @Column({ type: 'boolean' })
  readonly owns_gradient!: boolean | null;
  @Column({ type: 'json', nullable: true })
  readonly owns_gradient_tokens!: string | null;
  @Column({ type: 'boolean' })
  readonly owns_nextgen!: boolean | null;
  @Column({ type: 'json', nullable: true })
  readonly owns_nextgen_tokens!: string | null;
  @Column({ type: 'boolean' })
  readonly owns_lab!: boolean | null;
  @Column({ type: 'json', nullable: true })
  readonly owns_lab_tokens!: string | null;
  @Column({ type: 'varchar', length: 50, nullable: true })
  readonly profile_group_id!: string | null;
  @Column({ type: 'varchar', length: 50, nullable: true, default: null })
  readonly excluded_profile_group_id!: string | null;
  @Column({
    type: 'tinyint',
    nullable: false,
    insert: false,
    update: false,
    generatedType: 'STORED',
    asExpression: IS_PURE_PROFILE_GROUP_EXPRESSION
  })
  readonly is_pure_profile_group!: boolean;
  @Index('idx_user_group_is_private')
  @Column({ type: 'boolean', nullable: false, default: false })
  readonly is_private!: boolean;
  @Index('idx_user_group_is_direct_message')
  @Column({ type: 'boolean', nullable: false, default: false })
  readonly is_direct_message!: boolean;
  @Index('idx_beneficiary_grant')
  @Column({ type: 'varchar', length: 100, nullable: true })
  readonly is_beneficiary_of_grant_id!: string | null;
}

export enum FilterDirection {
  Received = 'RECEIVED',
  Sent = 'SENT'
}
