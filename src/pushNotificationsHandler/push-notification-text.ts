import { ApiMediaUploadMimeType } from '@/api/generated/models/ApiMediaUploadMimeType';
import { DROP_MEDIA_ALLOWED_EXTENSIONS_BY_MIME_TYPE } from '@/api/media/media-mime-types';

const MAX_MEDIA_FILENAME_LENGTH = 64;
const MEDIA_LABEL = 'Media';

const FILE_TYPE_LABEL_RULES: ReadonlyArray<{
  readonly label: string;
  readonly matches: (mimeType: string) => boolean;
}> = [
  { label: 'Image', matches: (mimeType) => mimeType.startsWith('image/') },
  { label: 'Video', matches: (mimeType) => mimeType.startsWith('video/') },
  { label: 'Audio', matches: (mimeType) => mimeType.startsWith('audio/') },
  { label: '3D Model', matches: (mimeType) => mimeType.startsWith('model/') },
  {
    label: 'PDF',
    matches: (mimeType) => mimeType === ApiMediaUploadMimeType.ApplicationPdf
  },
  {
    label: 'CSV',
    matches: (mimeType) => mimeType === ApiMediaUploadMimeType.TextCsv
  }
];

function getFileTypeLabel(mimeType: string): string {
  return (
    FILE_TYPE_LABEL_RULES.find((rule) => rule.matches(mimeType))?.label ??
    MEDIA_LABEL
  );
}

const SUPPORTED_MEDIA_EXTENSIONS_BY_LABEL = (
  Object.keys(
    DROP_MEDIA_ALLOWED_EXTENSIONS_BY_MIME_TYPE
  ) as ApiMediaUploadMimeType[]
).reduce<Record<string, string>>((acc, mimeType) => {
  DROP_MEDIA_ALLOWED_EXTENSIONS_BY_MIME_TYPE[mimeType].forEach((extension) => {
    acc[extension.toLowerCase()] = getFileTypeLabel(mimeType);
  });
  return acc;
}, {});

const SUPPORTED_MEDIA_EXTENSIONS_PATTERN = Object.keys(
  SUPPORTED_MEDIA_EXTENSIONS_BY_LABEL
)
  .map((extension) => extension.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|');

const MEDIA_URL_PATTERN = new RegExp(
  `https?:\\/\\/[^\\s<>)]+(?:${SUPPORTED_MEDIA_EXTENSIONS_PATTERN})(?:\\?[^\\s<>)]*)?(?:#[^\\s<>)]*)?`,
  'gi'
);

function getMediaFileNameForUrl(url: string): string | null {
  const cleanUrl = url.split(/[?#]/)[0];
  const fileName = cleanUrl.split('/').filter(Boolean).pop();
  if (!fileName) {
    return null;
  }
  try {
    return decodeURIComponent(fileName)
      .replace(/[\r\n\t]/g, ' ')
      .trim();
  } catch {
    return fileName.replace(/[\r\n\t]/g, ' ').trim();
  }
}

function truncateMediaFileName(fileName: string): string {
  if (fileName.length <= MAX_MEDIA_FILENAME_LENGTH) {
    return fileName;
  }
  return `${fileName.substring(0, MAX_MEDIA_FILENAME_LENGTH - 3)}...`;
}

function getMediaPlaceholderForUrl(url: string): string {
  const cleanUrl = url.split(/[?#]/)[0].toLowerCase();
  const extension = Object.keys(SUPPORTED_MEDIA_EXTENSIONS_BY_LABEL).find(
    (extension) => cleanUrl.endsWith(extension)
  );
  const label = extension
    ? SUPPORTED_MEDIA_EXTENSIONS_BY_LABEL[extension]
    : MEDIA_LABEL;
  const fileName = getMediaFileNameForUrl(url);
  return fileName
    ? `[${label} (${truncateMediaFileName(fileName)})]`
    : `[${label}]`;
}

function isSupportedMediaUrl(url: string): boolean {
  const cleanUrl = url.split(/[?#]/)[0].toLowerCase();
  return Object.keys(SUPPORTED_MEDIA_EXTENSIONS_BY_LABEL).some((extension) =>
    cleanUrl.endsWith(extension)
  );
}

export function sanitizePushNotificationText(input: string): string {
  return input
    .replace(
      /!\[[^\]]*]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g,
      (_match, url: string) => ` ${getMediaPlaceholderForUrl(url)} `
    )
    .replace(
      /(?<!!)\[[^\]]+]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g,
      (match, url: string) =>
        isSupportedMediaUrl(url) ? ` ${getMediaPlaceholderForUrl(url)} ` : match
    )
    .replace(MEDIA_URL_PATTERN, (url) => ` ${getMediaPlaceholderForUrl(url)} `)
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}
