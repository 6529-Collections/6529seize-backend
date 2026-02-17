const INT_LIKE = /^[+-]?(?:0|[1-9]\d*)(?:\.0+)?$/;

export class Numbers {
  private readonly NUMERIC_LIKE = /^[+-]?\d+(\.\d+)?$/;

  public parseIntOrNull(value: any): number | null {
    if (typeof value === 'number') {
      return Number.isFinite(value) && Number.isInteger(value)
        ? Number(value)
        : null;
    }

    if (typeof value === 'bigint') {
      return Number.isSafeInteger(Number(value)) ? Number(value) : null;
    }

    // anything that isn't a string is automatically rejected
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

  public parseIntOrThrow(value: any): number {
    const result = this.parseIntOrNull(value);
    if (result === null) {
      throw new Error(`${value} is not an integer`);
    }
    return result;
  }

  public range(start: number, end: number): number[] {
    return Array.from({ length: end - start + 1 }, (_, i) => i + start);
  }

  public parseNumberOrNull(value: any): number | null {
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : null;
    }

    // Reject anything that isn’t a string
    if (typeof value !== 'string') return null;

    // Trim all whitespace (including NBSP, tabs, etc.)
    const trimmed = value.trim();

    // Must match numeric format exactly (int or float)
    if (!this.NUMERIC_LIKE.test(trimmed)) return null;

    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }

  public parseNumberOrThrow(value: any): number {
    const result = this.parseNumberOrNull(value);
    if (result === null) {
      throw new Error(`${value} is not an number`);
    }
    return result;
  }
}

export const numbers = new Numbers();
