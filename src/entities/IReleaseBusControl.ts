import { Column, Entity, PrimaryColumn } from 'typeorm';
import { RELEASE_BUS_CONTROLS_TABLE } from '@/constants';
import type { ReleaseControlScope } from '@/releaseBus/release-bus.types';

@Entity(RELEASE_BUS_CONTROLS_TABLE)
export class ReleaseBusControlEntity {
  @PrimaryColumn({ type: 'varchar', length: 16 })
  readonly scope!: ReleaseControlScope;
  @Column({ type: 'boolean', default: false }) readonly paused!: boolean;
  @Column({ type: 'varchar', length: 1000, nullable: true, default: null })
  readonly reason!: string | null;
  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly github_actor!: string | null;
  @Column({ type: 'bigint' }) readonly updated_at!: number;
  @Column({ type: 'int', default: 1 }) readonly row_version!: number;
}
