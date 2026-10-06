import { Logger } from '@/logging';

const logger = Logger.get('SOURCIFY');
const LOOKUP_TIMEOUT_MS = 5000;

function readContractName(data: unknown): string | null {
  if (!data || typeof data !== 'object' || !('compilation' in data)) {
    return null;
  }
  const compilation = data.compilation;
  if (
    !compilation ||
    typeof compilation !== 'object' ||
    !('name' in compilation) ||
    typeof compilation.name !== 'string'
  ) {
    return null;
  }
  return compilation.name.trim() || null;
}

/** Optional display enrichment: provider failures must not stop indexing. */
export async function getSourcifyContractName(
  chainId: number,
  contract: string
): Promise<string | null> {
  if (
    !Number.isSafeInteger(chainId) ||
    chainId <= 0 ||
    !/^0x[\da-f]{40}$/i.test(contract)
  ) {
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
  try {
    const response = await fetch(
      `https://sourcify.dev/server/v2/contract/${chainId}/${contract}?fields=compilation.name`,
      { signal: controller.signal }
    );
    if (!response.ok) {
      if (response.status !== 404) {
        logger.warn(
          `[CONTRACT NAME LOOKUP FAILED] [STATUS ${response.status}]`
        );
      }
      return null;
    }
    return readContractName(await response.json());
  } catch {
    logger.warn('[CONTRACT NAME LOOKUP FAILED] [USING ADDRESS]');
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
