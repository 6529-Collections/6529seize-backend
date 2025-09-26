import { components } from '../../../external/nft-indexer-client-schema';

export type NftIndexerCollectionMetadata =
  components['schemas']['CollectionMetadata'];

export type NftIndexerCollectionStatus =
  components['schemas']['CollectionMetadata']['status'];

export type NftIndexerErrorApiModel = components['schemas']['Error'];
