import { Profile } from '../../../entities/IProfile';

/**
 * @swagger
 * components:
 *   schemas:
 *     Profile:
 *       type: object
 *       required:
 *         - normalised_handle
 *         - handle
 *         - external_id
 *         - primary_wallet
 *         - created_at
 *         - created_by_wallet
 *         - classification
 *       properties:
 *         normalised_handle:
 *           type: string
 *           example: a_handle
 *         handle:
 *           type: string
 *           example: A_Handle
 *         external_id:
 *           type: string
 *           format: uuid
 *           example: 123e4567-e89b-12d3-a456-426614174000
 *         primary_wallet:
 *           type: string
 *           example: 0x1234567890123456789012345678901234567890
 *         created_at:
 *           type: string
 *           format: date-time
 *           example: 2021-01-01T00:00:00Z
 *         created_by_wallet:
 *           type: string
 *           example: 0x1234567890123456789012345678901234567890
 *         updated_at:
 *           type: string
 *           format: date-time
 *           example: 2021-01-01T00:00:00Z
 *         updated_by_wallet:
 *           type: string
 *           example: 0x1234567890123456789012345678901234567890
 *         pfp_url:
 *           type: string
 *           example: https://example.com/pfp.jpg
 *         banner_1:
 *           type: string
 *           example: #000000
 *         banner_2:
 *           type: string
 *           example: #ff00ff
 *         website:
 *           type: string
 *           example: https://example.com
 *         classification:
 *           type: string
 *           enum:
 *             - GOVERNMENT_NAME
 *             - PSEUDONYM
 *             - ORGANISATION
 *             - AI
 *             - BOT
 *             - PARODY
 *             - COLLECTIONS
 *         sub_classification:
 *           type: string
 *           example: Arts & Culture - Studio
 */
export type ApiProfile = Profile;
