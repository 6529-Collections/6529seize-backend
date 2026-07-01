import 'typeorm/decorator/options/IndexOptions';

declare module 'typeorm/decorator/options/IndexOptions' {
  interface IndexOptions {
    synchronize?: boolean;
  }
}
