import { Entity, Index, PrimaryColumn } from 'typeorm';
import { PROFILE_GROUPS_TABLE } from '@/constants';

/**
 * Both ids use the schema default collation, like every table they are
 * joined with: a utf8mb3_bin column compared with a utf8mb4 one is converted
 * and loses its index. TypeORM's synchronize does not change the collation
 * of existing columns; production tables are moved with the
 * `profile-groups-collation` dbMigrationsLoop scope.
 */
@Entity(PROFILE_GROUPS_TABLE)
export class ProfileGroupEntity {
  @PrimaryColumn({
    type: 'varchar',
    length: 50,
    nullable: false
  })
  @Index()
  readonly profile_group_id!: string;
  @PrimaryColumn({
    type: 'varchar',
    length: 100,
    nullable: false
  })
  @Index()
  readonly profile_id!: string;
}
