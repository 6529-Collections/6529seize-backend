import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import { MEMES_SEASONS_TABLE } from '@/constants';

@Entity(MEMES_SEASONS_TABLE)
export class MemesSeason {
  @PrimaryColumn({ type: 'int' })
  id!: number;

  @CreateDateColumn({ type: 'datetime' })
  created_at?: Date;

  @Column({ type: 'int' })
  start_index!: number;

  @Column({ type: 'int' })
  end_index!: number;

  @Column({ type: 'int' })
  count!: number;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text' })
  display!: string;

  @Column({ type: 'float' })
  boost!: number;
}
