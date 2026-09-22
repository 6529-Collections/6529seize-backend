import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';

// Public preview hosts use DNS directly so each download owns cancellable queries.
// Do not fall back to OS lookup: its thread-pool work cannot be cancelled.
export async function resolvePreviewHost(
  hostname: string,
  signal?: AbortSignal
): Promise<{ address: string; family: number }[]> {
  signal?.throwIfAborted();
  const address = hostname.replace(/^\[|\]$/g, '');
  const family = isIP(address);
  if (family) return [{ address, family }];

  const resolver = new Resolver();
  const cancel = () => resolver.cancel();
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    const results = await Promise.allSettled([
      resolver.resolve4(hostname),
      resolver.resolve6(hostname)
    ]);
    signal?.throwIfAborted();
    return results.flatMap((result, index) => {
      if (result.status === 'fulfilled') {
        return result.value.map((ip) => ({
          address: ip,
          family: index === 0 ? 4 : 6
        }));
      }
      // A host may publish just one address family. Other DNS failures must
      // fail closed, since unexamined answers could contain private addresses.
      if (['ENODATA', 'ENOTFOUND'].includes(result.reason?.code)) return [];
      throw result.reason;
    });
  } finally {
    signal?.removeEventListener('abort', cancel);
    resolver.cancel();
  }
}
