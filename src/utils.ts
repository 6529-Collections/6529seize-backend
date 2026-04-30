export class Utils {
  public nullToUndefined<T>(val: T): T | undefined {
    if (val === null) return undefined;
    return val;
  }
}

export const utils = new Utils();
