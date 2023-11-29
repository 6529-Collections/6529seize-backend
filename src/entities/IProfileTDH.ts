import { Column, Entity, PrimaryColumn } from 'typeorm';
import { PROFILE_TDH_LOGS_TABLE, PROFILE_TDHS_TABLE } from '../constants';

class ProfileTDHBase {
  @Column({ type: 'int', nullable: false })
  tdh!: number;
  @Column({ type: 'int', nullable: false })
  boosted_tdh!: number;
}

@Entity(PROFILE_TDHS_TABLE)
export class ProfileTdh extends ProfileTDHBase {
  @PrimaryColumn({ type: 'varchar', length: 100 })
  profile_id!: string;
}

@Entity(PROFILE_TDH_LOGS_TABLE)
export class ProfileTdhLog extends ProfileTDHBase {
  @PrimaryColumn({ type: 'varchar', length: 100 })
  profile_id!: string;
  @PrimaryColumn({ type: 'int' })
  block!: number;
}
