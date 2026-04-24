import { randomUUID } from 'crypto';

const MAX_SLUG_LENGTH = 60;

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

export function slugifyBaseName(baseName: string): string {
  const normalized = baseName
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized.substring(0, MAX_SLUG_LENGTH).replace(/-+$/g, '');
}

export function getFileExtension(name: string): string {
  const lastDotIndex = name.lastIndexOf('.');
  if (lastDotIndex < 0) {
    return '';
  }
  return name.substring(lastDotIndex);
}
