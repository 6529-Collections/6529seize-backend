import { Column, Entity, PrimaryColumn } from 'typeorm';
import { DROP_WINNER_MEME_TABLE } from '../constants';

@Entity(DROP_WINNER_MEME_TABLE)
export class DropWinnerMemeEntity {
  @PrimaryColumn({ type: 'varchar', length: 100, nullable: false })
  readonly drop_id!: string;

  @Column({ type: 'int', nullable: false, unique: true })
  readonly meme_id!: number;
}
