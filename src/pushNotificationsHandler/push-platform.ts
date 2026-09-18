/** Interpret the canonical native platform without guessing unknown registrations. */
export function isIosPushPlatform(
  platform: string | null | undefined
): boolean {
  return platform?.trim().toLowerCase() === 'ios';
}
