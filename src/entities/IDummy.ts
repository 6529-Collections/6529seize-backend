import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import { DUMMY_TABLE } from '../constants';

@Entity(DUMMY_TABLE)
export class Dummy {
  @PrimaryColumn({ type: 'varchar', length: 50 })
  field_one!: string;

  @Column({ type: 'varchar', length: 150, nullable: true, default: null })
  field_two!: string | null;
}
