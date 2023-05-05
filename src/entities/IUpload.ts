import { Entity, Column, PrimaryColumn, CreateDateColumn } from 'typeorm';
import { CONSOLIDATED_UPLOADS_TABLE } from '../constants';

class Upload {
  @PrimaryColumn({ type: 'varchar', length: 8 })
  date!: Date;

  @Column({ type: 'int' })
  block!: number;

  @Column({ type: 'text' })
  tdh!: string;
}

@Entity({ name: CONSOLIDATED_UPLOADS_TABLE })
export class ConsolidatedTDHUpload extends Upload {}
