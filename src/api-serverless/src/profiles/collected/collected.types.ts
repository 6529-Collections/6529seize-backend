import { SortDirection } from '../../api-constants';

export enum CollectionType {
  MEMES = 'MEMES',
  GRADIENTS = 'GRADIENTS',
  MEMELAB = 'MEMELAB',
  NEXTGEN = 'NEXTGEN'
}

export enum CardSeizedStatus {
  SEIZED = 'SEIZED',
  NOT_SEIZED = 'NOT_SEIZED',
  ALL = 'ALL'
}

export interface CollectedCard {
  readonly collection: string;
  readonly token_id: number;
  readonly token_name: string;
  readonly img: string;
  readonly tdh: number | null;
  readonly rank: number | null;
  readonly seized_count: number | null;
  readonly szn: number | null;
}

export interface CollectedQuery {
  readonly handle_or_wallet: string;
  readonly collection: CollectionType | null;
  readonly account_for_consolidations: boolean;
  readonly seized: CardSeizedStatus;
  readonly page_size: number;
  readonly page: number;
  readonly sort_direction: SortDirection;
  readonly sort: 'token_id' | 'tdh' | 'rank';
  readonly szn: number | null;
}
