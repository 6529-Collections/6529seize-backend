import type { AssetTechnicalMetadata } from '@/artwork-documentation/assets/artwork-assets.types';

/** Exact source bytes accompany these selected signatures in pronom-source/. Not a full DROID implementation. */
export const PRONOM_SOURCE_COMMIT = 'e729b24f9ecca4722d6e3fd73703d8ec4b0c5724';
export const PRONOM_SIGNATURES = [
  {
    identifier: 'fmt/3',
    signature_id: 18,
    source_sha256:
      'd2816a078313a70b12f537e8576a176ef73c9c4bf1a8f8e67362761bc980596f'
  },
  {
    identifier: 'fmt/4',
    signature_id: 17,
    source_sha256:
      '41851812955a790279383349f48ee8b4be8447306f34cd3e65a120bc51e3c548'
  },
  {
    identifier: 'fmt/279',
    signature_id: 295,
    source_sha256:
      'c3a5ee1e2068cd7fa56db1e21822526ecec5b348f5d7af3dcac364d9f897ba49'
  },
  {
    identifier: 'fmt/566',
    signature_id: 902,
    source_sha256:
      '38c08008e164cb2b83a141f687e952f4908dfef28f942f9e33e5795948b124f8'
  },
  {
    identifier: 'fmt/567',
    signature_id: 903,
    source_sha256:
      '099ccab69dbdd59257ba3762928cf28e40387a881bb41fc7bcfe07202b5e2b1e'
  },
  {
    identifier: 'fmt/568',
    signature_id: 904,
    source_sha256:
      'd0536475dc11b7bfbb31b5ba2e3bf0db048bee22f992af45fd71a09cd43d0a5a'
  },
  {
    identifier: 'fmt/42',
    signature_id: 66,
    source_sha256:
      '53174fa888c466a23b94bbdfccf95bae20a2c98c8c88bba7ceb656804b139864'
  },
  {
    identifier: 'fmt/43',
    signature_id: 67,
    source_sha256:
      '60f18625356f01ff190c54b2bc68b5026c4367b1d36b87dab6c77ac788523485'
  },
  {
    identifier: 'fmt/44',
    signature_id: 68,
    source_sha256:
      '0a27e15860535ea2e501f125fe8b80208d1795fbb8edf86460e430ad1df4aac6'
  }
] as const;

function candidate(prefix: Buffer, suffix: Buffer): string | null {
  const magic = prefix.toString('ascii', 0, 6);
  if (
    ['GIF87a', 'GIF89a'].includes(magic) &&
    suffix.subarray(-5).includes(0x3b)
  )
    return magic === 'GIF87a' ? 'fmt/3' : 'fmt/4';
  if (
    prefix.toString('ascii', 0, 4) === 'fLaC' &&
    [0, 0x80].includes(prefix[4]) &&
    prefix.subarray(5, 8).equals(Buffer.from([0, 0, 34]))
  )
    return 'fmt/279';
  if (
    prefix.toString('ascii', 0, 4) === 'RIFF' &&
    prefix.toString('ascii', 8, 12) === 'WEBP'
  ) {
    const kinds: Record<string, string> = {
      'VP8 ': 'fmt/566',
      VP8L: 'fmt/567',
      VP8X: 'fmt/568'
    };
    return kinds[prefix.toString('ascii', 12, 16)] ?? null;
  }
  if (
    prefix.subarray(0, 4).equals(Buffer.from([0xff, 0xd8, 0xff, 0xe0])) &&
    prefix.toString('ascii', 6, 11) === 'JFIF\0' &&
    prefix[11] === 1 &&
    [0, 1, 2].includes(prefix[12]) &&
    [0, 1, 2].includes(prefix[13]) &&
    suffix.includes(Buffer.from([0xff, 0xd9]))
  )
    return `fmt/${42 + prefix[12]}`;
  return null;
}

export function identifyPronomFormat(
  prefix: Buffer,
  suffix: Buffer
): AssetTechnicalMetadata['format_registry'] {
  const id = candidate(prefix, suffix);
  const entry = PRONOM_SIGNATURES.find(
    (signature) => signature.identifier === id
  );
  return entry
    ? {
        status: 'signature_match',
        authority: 'PRONOM',
        ...entry,
        source_commit: PRONOM_SOURCE_COMMIT,
        identification_scope: 'selected_pronom_signatures'
      }
    : { status: 'unidentified', authority: null, identifier: null };
}
