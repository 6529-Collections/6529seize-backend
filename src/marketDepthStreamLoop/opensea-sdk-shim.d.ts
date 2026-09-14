// The repo's legacy TypeScript module resolution does not resolve package
// subpath exports. This is the narrow public surface of @opensea/sdk 12.7.0;
// runtime imports still load the official SDK's stream entry point.
declare module '@opensea/sdk/stream' {
  export enum EventType {
    ITEM_LISTED = 'item_listed',
    ITEM_RECEIVED_BID = 'item_received_bid',
    COLLECTION_OFFER = 'collection_offer',
    TRAIT_OFFER = 'trait_offer',
    ITEM_CANCELLED = 'item_cancelled',
    ORDER_INVALIDATE = 'order_invalidate',
    ORDER_REVALIDATE = 'order_revalidate',
    ITEM_SOLD = 'item_sold'
  }

  export type BaseStreamMessage<Payload> = {
    event_type: string;
    version: number;
    sent_at: string;
    payload: Payload;
  };

  export class OpenSeaStreamClient {
    constructor(options: {
      apiKey: string;
      onError?: (error: unknown) => void;
      logLevel?: LogLevel;
    });
    onEvents(
      collectionSlug: string,
      eventTypes: EventType[],
      callback: (event: BaseStreamMessage<unknown>) => void
    ): () => void;
    disconnect(callback?: () => void): void;
  }

  export enum LogLevel {
    DEBUG = 20,
    INFO = 30,
    WARN = 40,
    ERROR = 50
  }
}
