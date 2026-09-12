/** XML 1.0 cannot represent these controls. Reject them instead of silently changing source writing. */
export function xml(value: unknown): string {
  const text = String(value ?? '');
  if (
    Array.from(text).some((character) => {
      const code = character.charCodeAt(0);
      return (
        (code < 32 && ![9, 10, 13].includes(code)) ||
        code === 65534 ||
        code === 65535
      );
    })
  )
    throw new Error('Source contains a character unsupported by XML 1.0');
  const escaped: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;'
  };
  return text.replace(/[&<>"']/g, (character) => escaped[character]);
}
export const element = (name: string, content: unknown): string =>
  `<${name}>${xml(content)}</${name}>`;
