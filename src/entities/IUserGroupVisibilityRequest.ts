import { Column, Entity, PrimaryColumn } from 'typeorm';
import { USER_GROUP_VISIBILITY_REQUESTS_TABLE } from '@/constants';

@Entity(USER_GROUP_VISIBILITY_REQUESTS_TABLE)
export class UserGroupVisibilityRequestEntity {
  @PrimaryColumn({ type: 'char', length: 64 })
  readonly id!: string;

  @Column({ type: 'char', length: 64 })
  readonly payload_hash!: string;

  @Column({ type: 'boolean', default: false })
  readonly completed!: boolean;
}
