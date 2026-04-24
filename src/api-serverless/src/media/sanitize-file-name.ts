import { randomUUID } from 'node:crypto';

const MAX_SLUG_LENGTH = 60;
// Hard cap on how much of the input we will ever inspect. File names on
// real filesystems are ~255 bytes; this is well above that, but small
// enough to make the slugifier's work trivially bounded regardless of
// what the caller passes in. Avoids any DoS risk from oversized inputs.
const MAX_INPUT_LENGTH = 1024;

/**
 * Turns a user-supplied file name into a safe, unique file name for S3 storage.
 *
 * - Preserves ASCII alphanumerics and case (e.g. `MyPhoto`).
 * - Replaces every run of other characters (spaces, punctuation, emojis,
 *   non-ASCII letters) with a single dash.
 * - Trims leading/trailing dashes and caps the slug at 60 chars.
 * - Always appends a UUID so two uploads with the same name never collide.
 * - Preserves the original file extension (including case).
 *
 * Examples:
 *   "MyVacation Photo.JPG" → "MyVacation-Photo-<uuid>.JPG"
 *   "🎉🎊.jpg"             → "<uuid>.jpg"
 *   "archive.tar.gz"       → "archive-tar-<uuid>.gz"
 *   ""                     → "<uuid>"
 */
export function sanitizeFileName(file_name: string): string {
  const fileExtension = getFileExtension(file_name);
  const baseName = fileExtension
    ? file_name.substring(0, file_name.length - fileExtension.length)
    : file_name;
  const slug = slugifyBaseName(baseName);
  const uuid = randomUUID();
  return slug ? `${slug}-${uuid}${fileExtension}` : `${uuid}${fileExtension}`;
}

/**
 * Single-pass slugifier. Runs in O(min(baseName.length, MAX_INPUT_LENGTH)) —
 * deliberately avoids regex so complexity is obvious and there is no risk
 * of regex-engine backtracking on untrusted input.
 */
export function slugifyBaseName(baseName: string): string {
  const limit = Math.min(baseName.length, MAX_INPUT_LENGTH);
  const out: string[] = [];
  let lastWasDash = false;
  for (let i = 0; i < limit && out.length < MAX_SLUG_LENGTH; i++) {
    const code = baseName.codePointAt(i) ?? 0;
    const isAlphanumeric =
      (code >= 48 && code <= 57) || // 0-9
      (code >= 65 && code <= 90) || // A-Z
      (code >= 97 && code <= 122); // a-z
    if (isAlphanumeric) {
      out.push(baseName[i]);
      lastWasDash = false;
    } else if (!lastWasDash && out.length > 0) {
      // Collapse runs of non-alphanumerics into a single dash. Skip while
      // `out` is empty so leading dashes never appear.
      out.push('-');
      lastWasDash = true;
    }
  }
  // Trailing dash can happen if the loop exits because we hit MAX_SLUG_LENGTH
  // right after emitting a dash, or because we ran out of input on one.
  if (out.length > 0 && out.at(-1) === '-') {
    out.pop();
  }
  return out.join('');
}

export function getFileExtension(name: string): string {
  const lastDotIndex = name.lastIndexOf('.');
  if (lastDotIndex < 0) {
    return '';
  }
  return name.substring(lastDotIndex);
}
