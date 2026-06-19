import { CustomApiCompliantException } from '@/exceptions';

export function isLegacyRefreshEnabled(): boolean {
  return process.env.AUTH_LEGACY_REFRESH_DISABLED !== 'true';
}

export function assertLegacyRefreshEnabled(): void {
  if (!isLegacyRefreshEnabled()) {
    throw new CustomApiCompliantException(
      410,
      'Legacy refresh token redemption is disabled'
    );
  }
}
