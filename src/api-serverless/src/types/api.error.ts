import { ApiCompliantException } from '../../../exceptions';

/**
 * @swagger
 * components:
 *   schemas:
 *     ApiError:
 *       type: object
 *       required:
 *           - error
 *       properties:
 *         error:
 *           type: string
 *           example: An error occurred
 */
export type ApiError = ApiCompliantException;
