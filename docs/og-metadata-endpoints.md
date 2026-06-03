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
  "author": {
    "id": "3c469d89-3ef6-46d8-a911-8ab54f3e6f11",
    "handle": "creator",
    "primary_address": "0x1234567890abcdef1234567890abcdef12345678",
    "rep": null,
    "level": null,
    "tdh": null,
    "description": null,
    "twitter_handle": null,
    "media": [
      {
        "url": "https://cdn.6529.io/profile.jpg",
        "mime_type": null,
        "width": null,
        "height": null
      }
    ],
    "banner": {
      "primary": "#0f3BAc",
      "secondary": "#000000",
      "media": []
    }
  },
  "wave": {
    "id": "7aa5653c-75ad-418a-9ddb-53e23e7f8f48",
    "name": "The Memes",
    "description": "Wave description.",
    "subscribers_count": 1000,
    "drops_count": 250,
    "media": [
      {
        "url": "https://cdn.6529.io/wave.jpg",
        "mime_type": null,
        "width": null,
        "height": null
      }
    ]
  },
  "drop": {
    "id": "3f4267fe-83d0-4d1f-934e-46ab57f95efa",
    "serial_no": 12345,
    "drop_type": "SUBMISSION",
    "title": "Submission title",
    "description": "Submission description.",
    "content": "Submission content.",
    "votes": {
      "is_open": true,
      "total_votes_given": 11,
      "current_calculated_vote": 9,
      "predicted_final_vote": 10,
      "voters_count": 3,
      "place": 2
    },
    "media": [
      {
        "url": "https://cdn.6529.io/drop-image.jpg",
        "mime_type": "image/jpeg",
        "width": null,
        "height": null
      }
    ]
  }
}
```

The API returns entity facts only. It does not return top-level preview
`title`, `description`, selected `image`, selected `video`, selected `audio`,
Open Graph objects, Twitter card objects, canonical URLs, or frontend URLs.

`media` is always an array on the entity that owns the media. Profile and wave
media usually have one item; drop media can have multiple items.

Each media item has:

- `url`
- `mime_type`
- `width`
- `height`

`mime_type` is nullable because profile pfp and wave picture fields are stored
as URLs only.

`width` and `height` are nullable because profile, wave, and drop media do not
currently expose reliable generic dimensions.

IPFS URLs are returned through the 6529 IPFS gateway instead of as `ipfs://`
links.

## Profile Metadata

Profile responses return:

- `entity_type`: `PROFILE`
- `entity_id`: profile id
- `profile`: profile detail object

For the profile endpoint, profile detail includes:

- `id`
- `handle`
- `primary_address`
- `rep`
- `level`
- `tdh`
- `description`
- `twitter_handle`
- `media`
- `banner`

`profile.banner.primary` and `profile.banner.secondary` contain stored banner
colors when the profile uses a color banner. `profile.banner.media` contains
the banner image when the profile uses an image banner.

Top-level `author` objects for waves and drops only need to return author
preview fields:

- `id`
- `handle`
- `primary_address`
- `twitter_handle`
- `media`

`twitter_handle` should come from stored profile data when available. Until a
dedicated Twitter/X handle field exists, return `null`.

## Wave Metadata

Wave responses return:

- `entity_type`: `WAVE`
- `entity_id`: wave id
- `author`: lightweight wave creator info when available
- `wave`: wave detail object

Wave detail includes:

- `id`
- `name`
- `description`
- `subscribers_count`
- `drops_count`
- `media`

## Drop Metadata

Drop responses return:

- `entity_type`: `DROP`
- `entity_id`: drop id
- `author`: lightweight drop author info
- `wave`: wave detail object
- `drop`: drop detail object

Drop detail includes:

- `id`
- `serial_no`
- `drop_type`
- `title`
- `description`
- `content`
- `votes` for submission drops
- `media`

`drop_type` uses the existing V2 drop main type: `CHAT` or `SUBMISSION`.

## Text Normalization

Before returning text fields:

- strip HTML tags
- collapse repeated whitespace
- remove markdown-only syntax where reasonable
- avoid returning empty strings

## Implementation Notes

When implemented:

1. Add schemas and generated routes in `src/api-serverless/openapi.yaml`.
2. Run `cd src/api-serverless && npm run generate`.
3. Implement thin handlers under `src/api-serverless/src/og-metadata/`.
4. Keep normalization and media selection in shared helpers.
5. Add tests next to the implementation with filenames ending in `.test.ts`.

No database schema change is expected for the initial implementation unless a
dedicated profile Twitter/X handle field is added.
