import { ActivityEventEntity } from '../entities/IActivityEvent';

export interface NewActivityEvent extends Omit<
  ActivityEventEntity,
  'id' | 'created_at' | 'data'
> {
  readonly data: object;
}
