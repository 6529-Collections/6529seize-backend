import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { IDENTITIES_TABLE } from '@/constants';
import { ProfileClassification } from './IProfile';

@Entity(IDENTITIES_TABLE)
@Index('idx_identities_p_id_c_key', ['profile_id', 'consolidation_key'])
export class IdentityEntity {
  @PrimaryColumn({ type: 'varchar', length: 200, nullable: false })
  public readonly consolidation_key!: string;

  @Index('identity_profile_id_idx')
  @Column({ type: 'varchar', length: 50, nullable: true, default: null })
  public readonly profile_id!: string | null;

  @Column({ type: 'varchar', length: 50, nullable: false, unique: true })
  public readonly primary_address!: string;

  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  public readonly handle!: string | null;

  @Index('identity_normalised_handle_idx')
  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  public readonly normalised_handle!: string | null;

  @Index('identity_tdh_index_idx')
  @Column({ type: 'bigint', nullable: false })
  public readonly tdh!: number;

  @Index('identity_rep_index_idx')
  @Column({ type: 'bigint', nullable: false })
  public readonly rep!: number;

  @Index('identity_cic_index_idx')
  @Column({ type: 'bigint', nullable: false })
  public readonly cic!: number;

  @Index('identity_level_raw_idx')
  @Column({ type: 'bigint', nullable: false })
  public readonly level_raw!: number;

  @Column({ type: 'text', nullable: true, default: null })
  public readonly pfp!: string | null;

  @Column({ type: 'text', nullable: true, default: null })
  public readonly banner1!: string | null;

  @Column({ type: 'text', nullable: true, default: null })
  public readonly banner2!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true, default: null })
  public readonly classification!: ProfileClassification | null;

  @Column({ type: 'varchar', length: 255, nullable: true, default: null })
  public readonly sub_classification!: string | null;

  @Column({ type: 'double', nullable: false, default: 0 })
  readonly xtdh!: number;

  @Column({ type: 'double', nullable: false, default: 0 })
  readonly xtdh_rate!: number;

  @Column({ type: 'double', nullable: false, default: 0 })
  readonly basetdh_rate!: number;

  @Column({ type: 'double', nullable: false, default: 0 })
  readonly produced_xtdh!: number;

  @Column({ type: 'double', nullable: false, default: 0 })
  readonly granted_xtdh!: number;
}
