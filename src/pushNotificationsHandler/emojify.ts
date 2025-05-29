import * as nodeEmoji from 'node-emoji';
import * as martData from '@emoji-mart/data';

const martEmojis = martData as martData.EmojiMartData;

export function emojify(input: string): string {
  return input.replace(/:([a-zA-Z0-9_+-]+):/g, (match, shortcode) => {
    const emoji = nodeEmoji.emojify(match);
    if (emoji !== match) {
      return emoji;
    }

    const martEmoji = martEmojis.emojis[shortcode];

    return martEmoji?.skins?.[0]?.native ?? match;
  });
}
