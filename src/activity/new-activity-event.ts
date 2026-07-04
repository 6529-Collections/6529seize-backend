import { ActivityEventEntity } from '../entities/IActivityEvent';

export interface NewActivityEvent extends Omit<
  ActivityEventEntity,
  'id' | 'created_at' | 'data' | 'drop_id'
> {
  readonly drop_id: string | null;
  readonly data: object;
}
