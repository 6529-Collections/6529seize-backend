import { ApiAttachmentUploadMimeType } from '@/api/generated/models/ApiAttachmentUploadMimeType';
import { ApiMediaUploadMimeType } from '@/api/generated/models/ApiMediaUploadMimeType';
import {
  ATTACHMENT_ALLOWED_EXTENSIONS_BY_MIME_TYPE,
  DROP_MEDIA_ALLOWED_EXTENSIONS_BY_MIME_TYPE
} from '@/api/media/media-mime-types';

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
    matches: (mimeType) =>
      mimeType === ApiAttachmentUploadMimeType.ApplicationPdf
  },
  {
    label: 'CSV',
    matches: (mimeType) => mimeType === ApiAttachmentUploadMimeType.TextCsv
  }
];

function getFileTypeLabel(mimeType: string): string {
  return (
    FILE_TYPE_LABEL_RULES.find((rule) => rule.matches(mimeType))?.label ??
    MEDIA_LABEL
  );
}

const SUPPORTED_MEDIA_EXTENSIONS_BY_LABEL = [
  ...(
    Object.keys(
      DROP_MEDIA_ALLOWED_EXTENSIONS_BY_MIME_TYPE
    ) as ApiMediaUploadMimeType[]
  ).map((mimeType) => ({
    mimeType,
    extensions: DROP_MEDIA_ALLOWED_EXTENSIONS_BY_MIME_TYPE[mimeType]
  })),
  ...(
    Object.keys(
      ATTACHMENT_ALLOWED_EXTENSIONS_BY_MIME_TYPE
    ) as ApiAttachmentUploadMimeType[]
  ).map((mimeType) => ({
    mimeType,
    extensions: ATTACHMENT_ALLOWED_EXTENSIONS_BY_MIME_TYPE[mimeType]
  }))
].reduce<Record<string, string>>((acc, { mimeType, extensions }) => {
  extensions.forEach((extension) => {
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

export function getDropMediaPlaceholderForPush(
  url: string,
  mimeType: string | null | undefined
): string {
  const mimeTrimmed = mimeType?.trim();
  if (mimeTrimmed) {
    const label = getFileTypeLabel(mimeTrimmed);
    if (label !== MEDIA_LABEL) {
      const fileName = getMediaFileNameForUrl(url);
      return fileName
        ? `[${label} (${truncateMediaFileName(fileName)})]`
        : `[${label}]`;
    }
  }
  return getMediaPlaceholderForUrl(url);
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

type ResolveMarkdownReferenceResult =
  | { type: 'incomplete' }
  | { type: 'noOpenParen'; copyExclusiveEnd: number; nextIndex: number }
  | { type: 'resolved'; output: string; nextIndex: number };

function resolveMarkdownReferenceAt(
  input: string,
  markdownStart: number,
  isImage: boolean
): ResolveMarkdownReferenceResult {
  const labelStart = markdownStart + (isImage ? 2 : 1);
  const labelEnd = input.indexOf(']', labelStart);
  if (labelEnd === -1) {
    return { type: 'incomplete' };
  }

  const openParenIndex = labelEnd + 1;
  if (input[openParenIndex] !== '(') {
    return {
      type: 'noOpenParen',
      copyExclusiveEnd: labelEnd + 1,
      nextIndex: labelEnd + 1
    };
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
    return { type: 'incomplete' };
  }

  const url = input.substring(urlStart, urlEnd);
  const markdownEnd = findMarkdownReferenceEnd(input, urlEnd);
  if (markdownEnd === input.length && !input.endsWith(')')) {
    return { type: 'incomplete' };
  }

  const output =
    isImage || isSupportedMediaUrl(url)
      ? ` ${getMediaPlaceholderForUrl(url)} `
      : input.substring(markdownStart, markdownEnd);
  return { type: 'resolved', output, nextIndex: markdownEnd };
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

    const step = resolveMarkdownReferenceAt(input, index, isImage);
    if (step.type === 'incomplete') {
      result += input.substring(index);
      break;
    }
    if (step.type === 'noOpenParen') {
      result += input.substring(index, step.copyExclusiveEnd);
      index = step.nextIndex;
      continue;
    }
    result += step.output;
    index = step.nextIndex;
  }

  return result;
}

export function sanitizePushNotificationText(input: string): string {
  return replaceMarkdownMediaReferences(input)
    .replace(MEDIA_URL_PATTERN, (url) => ` ${getMediaPlaceholderForUrl(url)} `)
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}
