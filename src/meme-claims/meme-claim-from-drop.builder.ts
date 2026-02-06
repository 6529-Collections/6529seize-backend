import { DropMediaEntity, DropMetadataEntity } from '@/entities/IDrop';
import type {
  MemeClaimAnimationDetails,
  MemeClaimAttribute,
  MemeClaimImageDetails
} from '@/entities/IMemeClaim';

const METADATA_KEYS_SKIP = new Set([
  'title',
  'description',
  'payment_info',
  'commentary',
  'about_artist',
  'airdrop_config',
  'additional_media'
]);

const DATA_KEY_TO_TRAIT_TYPE: Record<string, string> = {
  artist: 'Artist',
  seizeArtistProfile: 'SEIZE Artist Profile',
  memeName: 'Meme Name',
  punk6529: 'Punk 6529',
  gradient: 'Gradient',
  palette: 'Palette',
  movement: 'Movement',
  dynamic: 'Dynamic',
  interactive: 'Interactive',
  collab: 'Collab',
  om: 'OM',
  threeD: '3D',
  type: 'Type',
  style: 'Style',
  jewel: 'Jewel',
  superpower: 'Superpower',
  dharma: 'Dharma',
  gear: 'Gear',
  clothing: 'Clothing',
  element: 'Element',
  mystery: 'Mystery',
  secrets: 'Secrets',
  weapon: 'Weapon',
  home: 'Home',
  parent: 'Parent',
  sibling: 'Sibling',
  food: 'Food',
  drink: 'Drink',
  pepe: 'Pepe',
  gm: 'GM',
  bonus: 'Bonus',
  boost: 'Boost',
  summer: 'Summer',
  tulip: 'Tulip',
  typeMeme: 'Type - Meme',
  typeSeason: 'Type - Season',
  typeCard: 'Type - Card',
  pointsPower: 'Points - Power',
  pointsWisdom: 'Points - Wisdom',
  pointsLoki: 'Points - Loki',
  pointsSpeed: 'Points - Speed',
  issuanceMonth: 'Issuance Month'
};

const POINTS_KEYS = new Set([
  'pointsPower',
  'pointsWisdom',
  'pointsLoki',
  'pointsSpeed'
]);

const NUMBER_KEYS = new Set(['typeMeme', 'typeSeason', 'typeCard']);

function mimeToFormat(mime: string): string {
  if (mime.startsWith('image/'))
    return mime.replace('image/', '').toUpperCase();
  if (mime === 'text/html') return 'HTML';
  if (mime.startsWith('video/'))
    return mime.replace('video/', '').toUpperCase();
  if (mime === 'model/gltf-binary') return 'GLB';
  return mime;
}

function parseAdditionalMedia(metadatas: DropMetadataEntity[]): {
  preview_image?: string;
} | null {
  const row = metadatas.find((m) => m.data_key === 'additional_media');
  if (!row?.data_value) return null;
  try {
    const parsed = JSON.parse(row.data_value) as Record<string, unknown>;
    const preview = parsed?.preview_image;
    return typeof preview === 'string' ? { preview_image: preview } : null;
  } catch {
    return null;
  }
}

function attrValue(dataKey: string, dataValue: string): string | number {
  if (NUMBER_KEYS.has(dataKey)) {
    const n = Number(dataValue);
    return Number.isFinite(n) ? n : dataValue;
  }
  const lower = dataValue.toLowerCase();
  if (lower === 'true') return 'Yes';
  if (lower === 'false') return 'No';
  return dataValue;
}

function buildAttributes(
  metadatas: DropMetadataEntity[],
  memeId: number,
  maxSeasonId: number
): MemeClaimAttribute[] {
  const attrs: MemeClaimAttribute[] = [];

  for (const m of metadatas) {
    if (METADATA_KEYS_SKIP.has(m.data_key)) continue;
    const traitType =
      DATA_KEY_TO_TRAIT_TYPE[m.data_key] ??
      m.data_key.charAt(0).toUpperCase() + m.data_key.slice(1);
    const value = attrValue(m.data_key, m.data_value);
    const attr: MemeClaimAttribute = { trait_type: traitType, value };
    if (POINTS_KEYS.has(m.data_key)) {
      attr.display_type = 'boost_percentage';
      attr.max_value = 100;
    }
    if (NUMBER_KEYS.has(m.data_key)) {
      attr.display_type = 'number';
    }
    attrs.push(attr);
  }

  const hasTypeSeason = metadatas.some((m) => m.data_key === 'typeSeason');
  if (!hasTypeSeason) {
    attrs.push({
      trait_type: 'Type - Season',
      value: maxSeasonId,
      display_type: 'number'
    });
  }
  const hasTypeCard = metadatas.some((m) => m.data_key === 'typeCard');
  if (!hasTypeCard) {
    attrs.push({
      trait_type: 'Type - Card',
      value: memeId,
      display_type: 'number'
    });
  }

  return attrs;
}

function imageDetailsFromMime(mimeType: string): MemeClaimImageDetails {
  return {
    format: mimeToFormat(mimeType),
    bytes: 0,
    sha256: '',
    width: 0,
    height: 0
  };
}

export type MemeClaimRowInput = {
  drop_id: string;
  meme_id: number;
  image_location: string | null;
  animation_location: string | null;
  metadata_location: string | null;
  description: string;
  name: string;
  image_url: string | null;
  attributes: MemeClaimAttribute[];
  image_details: MemeClaimImageDetails | null;
  animation_url: string | null;
  animation_details: MemeClaimAnimationDetails | null;
};

export function buildMemeClaimRowFromDrop(
  dropId: string,
  memeId: number,
  medias: DropMediaEntity[],
  metadatas: DropMetadataEntity[],
  maxSeasonId: number
): MemeClaimRowInput {
  const title = metadatas.find((m) => m.data_key === 'title')?.data_value ?? '';
  const description =
    metadatas.find((m) => m.data_key === 'description')?.data_value ?? '';
  const additionalMedia = parseAdditionalMedia(metadatas);
  const previewImageUrl = additionalMedia?.preview_image ?? null;

  const htmlMedia = medias.find(
    (m) => m.mime_type.toLowerCase() === 'text/html'
  );
  const videoMedia = medias.find((m) =>
    m.mime_type.toLowerCase().startsWith('video/')
  );
  const imageMedia = medias.find((m) => {
    const mt = m.mime_type.toLowerCase();
    return mt.startsWith('image/') || mt === 'image/gif';
  });
  const primaryMedia = htmlMedia ?? videoMedia ?? imageMedia ?? medias[0];
  if (!primaryMedia) {
    return {
      drop_id: dropId,
      meme_id: memeId,
      image_location: null,
      animation_location: null,
      metadata_location: null,
      description: description || ' ',
      name: title || ' ',
      image_url: null,
      attributes: buildAttributes(metadatas, memeId, maxSeasonId),
      image_details: null,
      animation_url: null,
      animation_details: null
    };
  }

  const mime = primaryMedia.mime_type.toLowerCase();
  const isHtml = mime === 'text/html';
  const isVideo = mime.startsWith('video/');
  const isImage = !isHtml && !isVideo;

  let image_url: string | null = null;
  let image_details: MemeClaimImageDetails | null = null;
  let animation_url: string | null = null;
  let animation_details: MemeClaimAnimationDetails | null = null;

  if (isImage) {
    image_url = primaryMedia.url;
    image_details = imageDetailsFromMime(primaryMedia.mime_type);
  } else {
    animation_url = primaryMedia.url;
    if (isHtml) {
      animation_details = { format: 'HTML' };
    } else {
      const format = mimeToFormat(primaryMedia.mime_type);
      if (format === 'GLB') {
        animation_details = { format: 'GLB', bytes: 0, sha256: '' };
      } else {
        animation_details = {
          format,
          bytes: 0,
          duration: 0,
          sha256: '',
          width: 0,
          height: 0,
          codecs: []
        };
      }
    }
    if (previewImageUrl) {
      image_url = previewImageUrl;
      image_details = imageDetailsFromMime('image/png');
    }
  }

  return {
    drop_id: dropId,
    meme_id: memeId,
    image_location: null,
    animation_location: null,
    metadata_location: null,
    description: description || ' ',
    name: title || ' ',
    image_url,
    attributes: buildAttributes(metadatas, memeId, maxSeasonId),
    image_details,
    animation_url,
    animation_details
  };
}
