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

  public roundDecimals(original: number, decimals: number): number {
    const exp = Math.pow(10, decimals);
    return Math.round(original * exp) / exp;
  }

  public parseIntOrThrow(value: any): number {
    const result = this.parseIntOrNull(value);
    if (result === null) {
      throw new Error(`${value} is not an integer`);
    }
    return result;
  }

  /**
   * Integers from start to end inclusive. Throws a RangeError instead of
   * expanding a range of more than `maxLength` values or one whose ends are
   * not safe integers (which cannot be counted exactly).
   */
  public range(
    start: number,
    end: number,
    maxLength: number = Numbers.MAX_RANGE_LENGTH
  ): number[] {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
      throw new RangeError('Range ends must be safe integers');
    }
    const length = end - start + 1;
    if (length > maxLength) {
      throw new RangeError(
        `Range of ${length} values exceeds the limit of ${maxLength}`
      );
    }
    return Array.from({ length: Math.max(0, length) }, (_, i) => i + start);
  }

  /** The most values `range` expands unless a caller sets its own limit. */
  public static readonly MAX_RANGE_LENGTH = 1_000_000;

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
