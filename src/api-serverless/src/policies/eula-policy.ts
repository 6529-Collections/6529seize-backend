import { ApiEulaVersion } from '@/api/generated/models/ApiEulaVersion';

export const CURRENT_EULA_VERSION = ApiEulaVersion._20260824;

export const EULA_VALIDITY_DAYS = 365;

export const EULA_VALIDITY_MS = EULA_VALIDITY_DAYS * 24 * 60 * 60 * 1000;
