export function equalIgnoreCase(w1: string, w2: string) {
  if (!w1 || !w2) {
    return false;
  }
  return w1.toLowerCase() === w2.toLowerCase();
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/**
 * At most `maxLength` UTF-16 code units of `value`, one fewer when the cut
 * would split a surrogate pair (an emoji). Text with a lone surrogate is not
 * valid Unicode: signed drop bodies that carry one are refused by the relays.
 */
export function sliceWholeCodePoints(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  const end =
    maxLength > 0 && isHighSurrogate(value.charCodeAt(maxLength - 1))
      ? maxLength - 1
      : maxLength;
  return value.slice(0, Math.max(0, end));
}

/** Whether `value` holds a surrogate that is not half of a pair. */
export function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (isHighSurrogate(code)) {
      if (!isLowSurrogate(value.charCodeAt(index + 1))) {
        return true;
      }
      index++;
    } else if (isLowSurrogate(code)) {
      return true;
    }
  }
  return false;
}
