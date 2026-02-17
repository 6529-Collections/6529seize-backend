import type { CanonicalLink } from '../types';
import type { PlatformAdapter } from './types';
import SuperRareAdapter from './superrare';
import { OpenSeaAdapter } from './opensea';
import { FoundationAdapter } from './foundation';
import { ManifoldAdapter } from './manifold';
import { TransientAdapter } from './transient';
import { env } from '@/env';

type RegisteredSource = {
  /** stable internal key, used for feature flags */
  id: string;
  adapter: PlatformAdapter;
  /** defaults to true if not specified */
  defaultEnabled?: boolean;
};

function isEnabled(source: RegisteredSource): boolean {
  const val = env.getStringOrNull(`LINK_RESOLVER_ENABLE_${source.id}`);
  if (val != null) {
    const v = String(val).trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'yes' || v === 'on';
  }
  return source.defaultEnabled !== false;
}

function deepMerge<T extends Record<string, any>>(
  base: T,
  patch: Partial<T>
): T {
  const out: any = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (
      v &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      typeof out[k] === 'object' &&
      out[k] !== null &&
      !Array.isArray(out[k])
    ) {
      out[k] = deepMerge(out[k], v as any);
    } else {
      out[k] = v;
    }
  }
  return out;
}

class CompositeAdapter implements PlatformAdapter {
  constructor(private readonly sources: RegisteredSource[]) {}

  canHandle(canonical: CanonicalLink): boolean {
    return this.sources.some(
      (s) => isEnabled(s) && s.adapter.canHandle(canonical)
    );
  }

  async resolveFast(canonical: CanonicalLink): Promise<any> {
    let patch: any = {};
    let didAny = false;

    for (const s of this.sources) {
      if (!isEnabled(s)) continue;
      if (!s.adapter.canHandle(canonical)) continue;
      const res = await s.adapter.resolveFast(canonical);
      if (!res) continue;
      didAny = true;
      if (res.patch) patch = deepMerge(patch, res.patch);
    }

    if (!didAny) return null;
    return { patch };
  }

  async resolveSlow(canonical: CanonicalLink): Promise<any> {
    let patch: any = {};
    let didAny = false;

    for (const s of this.sources) {
      if (!isEnabled(s)) continue;
      if (!s.adapter.canHandle(canonical)) continue;
      if (!s.adapter.resolveSlow) continue;
      const res = await s.adapter.resolveSlow(canonical).catch(() => null);
      if (!res) continue;
      didAny = true;
      if (res.patch) patch = deepMerge(patch, res.patch);
    }

    if (!didAny) return null;
    return { patch };
  }
}

const sources: RegisteredSource[] = [
  {
    id: 'SUPERRARE_BAZAAR_ONCHAIN',
    adapter: new SuperRareAdapter(),
    // Keyless (onchain) integration.
    defaultEnabled: true
  },
  {
    id: 'OPENSEA_API',
    adapter: new OpenSeaAdapter(),
    // Requires OPENSEA_API_KEY; adapter will no-op if missing.
    defaultEnabled: true
  },
  {
    id: 'FOUNDATION_ONCHAIN',
    adapter: new FoundationAdapter(),
    defaultEnabled: true
  },
  {
    id: 'MANIFOLD_INSTANCE_DATA',
    adapter: new ManifoldAdapter(),
    defaultEnabled: true
  },
  {
    id: 'TRANSIENT_ONCHAIN',
    adapter: new TransientAdapter(),
    defaultEnabled: true
  }
];

export function getAdapterFor(
  canonical: CanonicalLink
): PlatformAdapter | null {
  const eligible = sources.filter(
    (s) => s.adapter.canHandle(canonical) && isEnabled(s)
  );
  if (!eligible.length) return null;
  return new CompositeAdapter(eligible);
}
