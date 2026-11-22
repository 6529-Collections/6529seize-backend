export function buildMultiProfileTitlePrefix(profileHandle: string): string {
  const normalizedHandle = profileHandle.startsWith('@')
    ? profileHandle.slice(1)
    : profileHandle;
  return `[${normalizedHandle}]`;
}
