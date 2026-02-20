import type { CanonicalLink, NormalizedNftCard } from '../types';

export interface AdapterResult {
  patch: Partial<NormalizedNftCard>;
}

export interface PlatformAdapter {
  canHandle(canonical: CanonicalLink): boolean;
  resolveFast(ctx: CanonicalLink): Promise<AdapterResult | null>;
  resolveSlow?(ctx: CanonicalLink): Promise<AdapterResult | null>;
}
