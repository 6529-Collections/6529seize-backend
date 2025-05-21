import * as short from 'short-uuid';

export class Ids {
  public uniqueShortId(): string {
    return short.generate();
  }

  public isValidUuid(str: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      str
    );
  }
}

export const ids = new Ids();
