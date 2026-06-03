# OG Metadata Endpoints

Date: 2026-06-03

## Goal

Add read-only API endpoints that return backend-known metadata inputs for
profile, wave, and drop previews.

The API should not return rendered HTML tags, Open Graph objects, Twitter card
objects, canonical URLs, or frontend page URLs. Clients decide how to turn this
information into `<title>`, canonical, Open Graph, and Twitter metadata.

## Endpoints

Use a dedicated `/og-metadata` namespace so this preview surface does not
conflict with existing entity metadata endpoints.

```http
GET /og-metadata/profiles/{identity}
GET /og-metadata/waves/{id}
GET /og-metadata/drops/{drop}
```

`identity` accepts profile id, handle, wallet address, or ENS name.

`id` is the wave id.

`drop` is resolved deterministically:

- UUID format: look up by drop id.
- digits only: look up by drop serial number.
- anything else: return `400`.

## Behavior

All endpoints:

- use `GET`
- use no authenticated-user-specific behavior
- return `404` when the entity does not exist or when existing public API
  behavior would hide that entity
- may be cached by API/CDN because the response does not depend on viewer state
- return only backend-known content and media inputs

Non-public waves and drops keep existing public API behavior and return `404`.

## Response Shape

Recommended schema name: `ApiOgMetadata`.

```json
{
  "entity_type": "DROP",
  "entity_id": "3f4267fe-83d0-4d1f-934e-46ab57f95efa",
  "title": "Submission title",
  "description": "Submission description or clean text preview.",
  "media": {
    "image": {
      "url": "https://cdn.6529.io/drop-image.jpg",
      "mime_type": "image/jpeg",
      "width": null,
      "height": null,
      "alt": "Submission title"
    },
    "video": null,
    "audio": null
  },
  "author": {
    "id": "3c469d89-3ef6-46d8-a911-8ab54f3e6f11",
    "handle": "creator",
    "primary_address": "0x1234567890abcdef1234567890abcdef12345678",
    "pfp": "https://cdn.6529.io/profile.jpg",
    "rep": null,
    "level": null,
    "tdh": null,
    "description": null,
    "twitter_handle": null
  },
  "wave": {
    "id": "7aa5653c-75ad-418a-9ddb-53e23e7f8f48",
    "name": "The Memes",
    "picture": "https://cdn.6529.io/wave.jpg"
  },
  "drop": {
    "id": "3f4267fe-83d0-4d1f-934e-46ab57f95efa",
    "serial_no": 12345,
    "drop_type": "SUBMISSION"
  }
}
```

`media.image`, `media.video`, and `media.audio` are selected media inputs.
Clients decide whether to render them as `og:image`, `twitter:image`,
`og:video`, or other tags.

`mime_type` is nullable because drop media has MIME type data, but profile pfp
and wave picture fields are stored as URLs only.

`width` and `height` are nullable because profile, wave, and drop media do not
currently expose reliable generic dimensions.

## Profile Metadata

Profile responses return:

- `entity_type`: `PROFILE`
- `entity_id`: profile id
- `title`: profile handle or a fallback display value
- `description`: profile bio/description or fallback text
- `media.image`: profile `pfp` when available
- `profile`: profile detail object

For the profile endpoint, profile detail includes:

- `id`
- `handle`
- `primary_address`
- `pfp`
- `rep`
- `level`
- `tdh`
- `description`
- `twitter_handle`

Top-level `author` objects for waves and drops only need to return author
preview fields:

- `id`
- `handle`
- `pfp`
- `twitter_handle`

`twitter_handle` should come from stored profile data when available. Until a
dedicated Twitter/X handle field exists, return `null`.

## Wave Metadata

Wave responses return:

- `entity_type`: `WAVE`
- `entity_id`: wave id
- `title`: wave name
- `description`: wave description drop content, or fallback text
- `media.image`: wave picture, first description-drop image, author pfp, or null
- `media.video`: first description-drop video, or null
- `media.audio`: first description-drop audio, or null
- `author`: lightweight wave creator info when available
- `wave`: wave detail object

## Drop Metadata

Drop responses return:

- `entity_type`: `DROP`
- `entity_id`: drop id
- `title`: priority metadata title, explicit drop title, first content line, or
  fallback text
- `description`: priority metadata description, content preview, quoted content
  preview, or fallback text
- `media.image`: first drop image, wave picture, author pfp, or null
- `media.video`: first drop video, or null
- `media.audio`: first drop audio, or null
- `author`: lightweight drop author info
- `wave`: wave detail object
- `drop`: drop detail object

Drop detail includes:

- `id`
- `serial_no`
- `drop_type`

`drop_type` uses the existing V2 drop main type: `CHAT` or `SUBMISSION`.

## Text Normalization

Before returning title and description:

- strip HTML tags
- collapse repeated whitespace
- remove markdown-only syntax where reasonable
- avoid returning empty strings
- cap title at 120 characters
- cap description at 300 characters

## Implementation Notes

When implemented:

1. Add schemas and generated routes in `src/api-serverless/openapi.yaml`.
2. Run `cd src/api-serverless && npm run generate`.
3. Implement thin handlers under `src/api-serverless/src/og-metadata/`.
4. Keep normalization and media selection in shared helpers.
5. Add tests next to the implementation with filenames ending in `.test.ts`.

No database schema change is expected for the initial implementation unless a
dedicated profile Twitter/X handle field is added.
