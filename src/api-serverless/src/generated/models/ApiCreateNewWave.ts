/**
 * Seize API
 * This is the API interface description for the most commonly used operations in Seize API.  Some modifying endpoints require an authentication token.   We are in the process of documenting all Seize APIs.   If there is an API that you need, please ping us in Discord and we will aim to prioritize its documentation.
 *
 * OpenAPI spec version: 1.0.0
 * 
 *
 * NOTE: This class is auto generated by OpenAPI Generator (https://openapi-generator.tech).
 * https://openapi-generator.tech
 * Do not edit the class manually.
 */

import { ApiCreateNewWaveParticipationConfig } from '../models/ApiCreateNewWaveParticipationConfig';
import { ApiCreateNewWaveVisibilityConfig } from '../models/ApiCreateNewWaveVisibilityConfig';
import { ApiCreateNewWaveVotingConfig } from '../models/ApiCreateNewWaveVotingConfig';
import { ApiCreateWaveConfig } from '../models/ApiCreateWaveConfig';
import { ApiCreateWaveDropRequest } from '../models/ApiCreateWaveDropRequest';
import { ApiWaveOutcome } from '../models/ApiWaveOutcome';
import { HttpFile } from '../http/http';

export class ApiCreateNewWave {
    /**
    * The name of the wave
    */
    'name': string;
    /**
    * The picture of the wave
    */
    'picture': string | null;
    'description_drop': ApiCreateWaveDropRequest;
    'voting': ApiCreateNewWaveVotingConfig;
    'visibility': ApiCreateNewWaveVisibilityConfig;
    'participation': ApiCreateNewWaveParticipationConfig;
    'wave': ApiCreateWaveConfig;
    'outcomes': Array<ApiWaveOutcome>;

    static readonly discriminator: string | undefined = undefined;

    static readonly attributeTypeMap: Array<{name: string, baseName: string, type: string, format: string}> = [
        {
            "name": "name",
            "baseName": "name",
            "type": "string",
            "format": ""
        },
        {
            "name": "picture",
            "baseName": "picture",
            "type": "string",
            "format": ""
        },
        {
            "name": "description_drop",
            "baseName": "description_drop",
            "type": "ApiCreateWaveDropRequest",
            "format": ""
        },
        {
            "name": "voting",
            "baseName": "voting",
            "type": "ApiCreateNewWaveVotingConfig",
            "format": ""
        },
        {
            "name": "visibility",
            "baseName": "visibility",
            "type": "ApiCreateNewWaveVisibilityConfig",
            "format": ""
        },
        {
            "name": "participation",
            "baseName": "participation",
            "type": "ApiCreateNewWaveParticipationConfig",
            "format": ""
        },
        {
            "name": "wave",
            "baseName": "wave",
            "type": "ApiCreateWaveConfig",
            "format": ""
        },
        {
            "name": "outcomes",
            "baseName": "outcomes",
            "type": "Array<ApiWaveOutcome>",
            "format": ""
        }    ];

    static getAttributeTypeMap() {
        return ApiCreateNewWave.attributeTypeMap;
    }

    public constructor() {
    }
}
