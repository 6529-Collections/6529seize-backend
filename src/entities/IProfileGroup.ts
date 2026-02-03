import { Entity, Index, PrimaryColumn } from 'typeorm';
import { PROFILE_GROUPS_TABLE } from '@/constants';

@Entity(PROFILE_GROUPS_TABLE)
export class ProfileGroupEntity {
  @PrimaryColumn({
    type: 'varchar',
    length: 50,
    nullable: false,
    collation: 'utf8_bin'
  })
  @Index()
  readonly profile_group_id!: string;
  @PrimaryColumn({
    type: 'varchar',
    length: 100,
    nullable: false,
    collation: 'utf8_bin'
  })
  @Index()
  readonly profile_id!: string;
}
