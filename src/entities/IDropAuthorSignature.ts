import { Column, Entity, PrimaryColumn } from 'typeorm';
import { DROP_AUTHOR_SIGNATURES_TABLE } from '@/constants';

// Present only while the drop's current content is the body of a device
// signed POST or EDIT event.
@Entity(DROP_AUTHOR_SIGNATURES_TABLE)
export class DropAuthorSignatureEntity {
  @PrimaryColumn({ type: 'varchar', length: 100, nullable: false })
  readonly drop_id!: string;

  @Column({ type: 'varchar', length: 66, nullable: false })
  readonly event_id!: string;

  @Column({ type: 'bigint', nullable: false })
  readonly signed_at!: number;
}
