/**
 * Seize API
 * Following is the API interface description for most common operations in Seize API. Some modifying endpoints may need authentication token.
 *
 * OpenAPI spec version: 1.0.0
 * 
 *
 * NOTE: This class is auto generated by OpenAPI Generator (https://openapi-generator.tech).
 * https://openapi-generator.tech
 * Do not edit the class manually.
 */

import { CreateNewWaveVotingConfig } from '../models/CreateNewWaveVotingConfig';
import { WaveConfig } from '../models/WaveConfig';
import { WaveOutcome } from '../models/WaveOutcome';
import { WaveParticipationConfig } from '../models/WaveParticipationConfig';
import { WaveVisibilityConfig } from '../models/WaveVisibilityConfig';
import { HttpFile } from '../http/http';

export class CreateNewWave {
    /**
    * The name of the wave
    */
    'name': string;
    /**
    * The description of the wave
    */
    'description': string;
    'voting': CreateNewWaveVotingConfig;
    'visibility': WaveVisibilityConfig;
    'participation': WaveParticipationConfig;
    'wave': WaveConfig;
    'outcomes'?: Array<WaveOutcome>;

    static readonly discriminator: string | undefined = undefined;

    static readonly attributeTypeMap: Array<{name: string, baseName: string, type: string, format: string}> = [
        {
            "name": "name",
            "baseName": "name",
            "type": "string",
            "format": ""
        },
        {
            "name": "description",
            "baseName": "description",
            "type": "string",
            "format": ""
        },
        {
            "name": "voting",
            "baseName": "voting",
            "type": "CreateNewWaveVotingConfig",
            "format": ""
        },
        {
            "name": "visibility",
            "baseName": "visibility",
            "type": "WaveVisibilityConfig",
            "format": ""
        },
        {
            "name": "participation",
            "baseName": "participation",
            "type": "WaveParticipationConfig",
            "format": ""
        },
        {
            "name": "wave",
            "baseName": "wave",
            "type": "WaveConfig",
            "format": ""
        },
        {
            "name": "outcomes",
            "baseName": "outcomes",
            "type": "Array<WaveOutcome>",
            "format": ""
        }    ];

    static getAttributeTypeMap() {
        return CreateNewWave.attributeTypeMap;
    }

    public constructor() {
    }
}
