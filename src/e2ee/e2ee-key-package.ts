/** MLS ProtocolVersion mls10 (RFC 9420 section 6). */
const MLS_10 = 0x0001;

/**
 * The cipher_suite of a TLS-serialized KeyPackage, or null when the bytes do
 * not start like an MLS 1.0 KeyPackage. RFC 9420 section 10 serializes
 * `version` (uint16) and then `cipher_suite` (uint16) first; only those four
 * bytes are read. Clients validate the whole KeyPackage (signature, lifetime,
 * capabilities) with OpenMLS when they use it.
 */
export function readE2eeKeyPackageCiphersuite(data: Buffer): number | null {
  if (data.length < 4 || data.readUInt16BE(0) !== MLS_10) return null;
  return data.readUInt16BE(2);
}
