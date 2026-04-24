export const DROP_MEDIA_ALLOWED_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'video/mp4',
  'video/x-msvideo',
  'audio/mpeg',
  'audio/mpeg3',
  'audio/ogg',
  'audio/mp3',
  'audio/wav',
  'audio/aac',
  'audio/x-aac',
  'model/gltf-binary',
  'video/quicktime',
  'image/webp',
  'application/pdf',
  'text/csv'
] as const;

export const DROP_MEDIA_ALLOWED_EXTENSIONS_BY_MIME_TYPE: Record<
  (typeof DROP_MEDIA_ALLOWED_MIME_TYPES)[number],
  readonly string[]
> = {
  'image/png': ['.png'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/jpg': ['.jpg', '.jpeg'],
  'image/gif': ['.gif'],
  'video/mp4': ['.mp4'],
  'video/x-msvideo': ['.avi'],
  'audio/mpeg': ['.mp3', '.mpeg'],
  'audio/mpeg3': ['.mp3', '.mpeg'],
  'audio/ogg': ['.ogg'],
  'audio/mp3': ['.mp3'],
  'audio/wav': ['.wav'],
  'audio/aac': ['.aac'],
  'audio/x-aac': ['.aac'],
  'model/gltf-binary': ['.glb'],
  'video/quicktime': ['.mov', '.qt'],
  'image/webp': ['.webp'],
  'application/pdf': ['.pdf'],
  'text/csv': ['.csv']
};

export const DROP_MEDIA_DOCUMENT_MIME_TYPES = [
  'application/pdf',
  'text/csv'
] as const;

export const DANGEROUS_MEDIA_FILE_EXTENSIONS = [
  '.app',
  '.bat',
  '.cmd',
  '.com',
  '.dll',
  '.dmg',
  '.exe',
  '.jar',
  '.js',
  '.msi',
  '.ps1',
  '.scr',
  '.sh',
  '.vbs'
] as const;
