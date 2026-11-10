type DetachableArrayBuffer = ArrayBuffer & {
  transfer?: (length?: number) => ArrayBuffer;
};

/**
 * Frees a buffer that owns its whole ArrayBuffer now, instead of at some
 * later garbage collection, and leaves it empty. A zero-length transfer
 * detaches the old backing store without copying it. Pooled or shared
 * buffers are left alone.
 */
export function releaseBuffer(buffer: Buffer): void {
  const backing = buffer.buffer as unknown as DetachableArrayBuffer;
  if (buffer.byteOffset !== 0 || buffer.byteLength !== backing.byteLength) {
    return;
  }
  try {
    backing.transfer?.(0);
  } catch {
    // Not detachable: garbage collection frees it instead.
  }
}
