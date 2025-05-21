const INT_LIKE = /^[+-]?(?:0|[1-9]\d*)(?:\.0+)?$/;

export class Numbers {
  public parseIntOrNull(value: any): number | null {
    if (typeof value === 'number') {
      return Number.isFinite(value) && Number.isInteger(value) ? value : null;
    }

    // anything that isn’t a string is automatically rejected
    if (typeof value !== 'string') return null;

    // trim *all* whitespace (including NBSP, tabs, new lines…)
    const trimmed = value.trim();

    // string must match the regexp exactly
    if (!INT_LIKE.test(trimmed)) return null;

    // safe to convert – it’s an exact int
    return Number(trimmed);
  }

  public isNumber(s: string): boolean {
    return !isNaN(Number(s));
  }

  public sum(ns: number[]): number {
    return ns.reduce((sum, n) => sum + n, 0);
  }
}

export const numbers = new Numbers();
