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
  .map((extension) => extension.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`))
  .join('|');

const MEDIA_URL_PATTERN = new RegExp(
  String.raw`https?:\/\/[^\s<>)]+(?:${SUPPORTED_MEDIA_EXTENSIONS_PATTERN})(?:\?[^\s<>)]*)?(?:#[^\s<>)]*)?`,
  'gi'
);

function getMediaFileNameForUrl(url: string): string | null {
  const cleanUrl = url.split(/[?#]/)[0];
  const pathSegments = cleanUrl.split('/');
  let fileName: string | undefined;
  for (let i = pathSegments.length - 1; i >= 0; i--) {
    if (pathSegments[i]) {
      fileName = pathSegments[i];
      break;
    }
  }
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

function isMarkdownWhitespace(char: string): boolean {
  return char === ' ' || char === '\n' || char === '\r' || char === '\t';
}

function findMarkdownUrlEnd(input: string, start: number): number {
  for (let i = start; i < input.length; i++) {
    const char = input[i];
    if (char === ')' || isMarkdownWhitespace(char)) {
      return i;
    }
  }
  return input.length;
}

function findMarkdownReferenceEnd(input: string, start: number): number {
  for (let i = start; i < input.length; i++) {
    if (input[i] === ')') {
      return i + 1;
    }
  }
  return input.length;
}

function replaceMarkdownMediaReferences(input: string): string {
  let result = '';
  let index = 0;

  while (index < input.length) {
    const isImage = input[index] === '!' && input[index + 1] === '[';
    const isLink = input[index] === '[';

    if (!isImage && !isLink) {
      result += input[index];
      index++;
      continue;
    }

    const markdownStart = index;
    const labelStart = index + (isImage ? 2 : 1);
    const labelEnd = input.indexOf(']', labelStart);
    if (labelEnd === -1) {
      result += input.substring(index);
      break;
    }

    const openParenIndex = labelEnd + 1;
    if (input[openParenIndex] !== '(') {
      result += input.substring(index, labelEnd + 1);
      index = labelEnd + 1;
      continue;
    }

    let urlStart = openParenIndex + 1;
    while (isMarkdownWhitespace(input[urlStart])) {
      urlStart++;
    }

    const wrappedInAngleBrackets = input[urlStart] === '<';
    if (wrappedInAngleBrackets) {
      urlStart++;
    }

    const urlEnd = wrappedInAngleBrackets
      ? input.indexOf('>', urlStart)
      : findMarkdownUrlEnd(input, urlStart);
    if (urlEnd === -1) {
      result += input.substring(index);
      break;
    }

    const url = input.substring(urlStart, urlEnd);
    const markdownEnd = findMarkdownReferenceEnd(input, urlEnd);
    if (markdownEnd === input.length && input[input.length - 1] !== ')') {
      result += input.substring(index);
      break;
    }

    if (isImage || isSupportedMediaUrl(url)) {
      result += ` ${getMediaPlaceholderForUrl(url)} `;
    } else {
      result += input.substring(markdownStart, markdownEnd);
    }
    index = markdownEnd;
  }

  return result;
}

export function sanitizePushNotificationText(input: string): string {
  return replaceMarkdownMediaReferences(input)
    .replace(MEDIA_URL_PATTERN, (url) => ` ${getMediaPlaceholderForUrl(url)} `)
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}
