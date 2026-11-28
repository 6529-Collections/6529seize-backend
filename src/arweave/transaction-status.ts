/** Shape exposed as confirmed by the SDK's TransactionStatusResponse. */
export function isTransactionConfirmation(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  return (
    'block_indep_hash' in value &&
    typeof value.block_indep_hash === 'string' &&
    value.block_indep_hash.length > 0 &&
    'block_height' in value &&
    typeof value.block_height === 'number' &&
    Number.isSafeInteger(value.block_height) &&
    value.block_height >= 0 &&
    'number_of_confirmations' in value &&
    typeof value.number_of_confirmations === 'number' &&
    Number.isSafeInteger(value.number_of_confirmations) &&
    value.number_of_confirmations >= 0
  );
}

export function isTransactionConfirmationText(text: string): boolean {
  try {
    return isTransactionConfirmation(JSON.parse(text));
  } catch {
    return false;
  }
}
