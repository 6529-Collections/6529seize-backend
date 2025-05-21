export function equalIgnoreCase(w1: string, w2: string) {
  if (!w1 || !w2) {
    return false;
  }
  return w1.toLowerCase() === w2.toLowerCase();
}
