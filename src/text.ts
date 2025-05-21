export class Text {
  public replaceEmojisWithHex(inputString: string): string {
    return inputString.replace(
      /[\uD83C-\uDBFF][\uDC00-\uDFFF]/g,
      (match: string) => {
        const codePoint = match.codePointAt(0);
        if (codePoint) {
          const emojiHex = codePoint.toString(16).toUpperCase();
          return `U+${emojiHex}`;
        }
        return match;
      }
    );
  }
}

export const text = new Text();
