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

import { Drop } from '../models/Drop';
import { ProfileMin } from '../models/ProfileMin';
import { WaveConfig } from '../models/WaveConfig';
import { WaveContributorOverview } from '../models/WaveContributorOverview';
import { WaveMetrics } from '../models/WaveMetrics';
import { WaveOutcome } from '../models/WaveOutcome';
import { WaveParticipationConfig } from '../models/WaveParticipationConfig';
import { WaveSubscriptionTargetAction } from '../models/WaveSubscriptionTargetAction';
import { WaveVisibilityConfig } from '../models/WaveVisibilityConfig';
import { WaveVotingConfig } from '../models/WaveVotingConfig';
import { HttpFile } from '../http/http';

export class Wave {
    /**
    * The ID of the wave
    */
    'id': string;
    /**
    * Sequence number of the wave in Seize
    */
    'serial_no': number;
    'author': ProfileMin;
    /**
    * The name of the wave
    */
    'name': string;
    /**
    * The picture of the wave
    */
    'picture': string | null;
    'created_at': number;
    'description_drop': Drop;
    'voting': WaveVotingConfig;
    'visibility': WaveVisibilityConfig;
    'participation': WaveParticipationConfig;
    'wave': WaveConfig;
    'outcomes': Array<WaveOutcome>;
    'contributors_overview': Array<WaveContributorOverview>;
    'subscribed_actions': Array<WaveSubscriptionTargetAction>;
    'metrics': WaveMetrics;

    static readonly discriminator: string | undefined = undefined;

    static readonly attributeTypeMap: Array<{name: string, baseName: string, type: string, format: string}> = [
        {
            "name": "id",
            "baseName": "id",
            "type": "string",
            "format": ""
        },
        {
            "name": "serial_no",
            "baseName": "serial_no",
            "type": "number",
            "format": "int64"
        },
        {
            "name": "author",
            "baseName": "author",
            "type": "ProfileMin",
            "format": ""
        },
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
            "name": "created_at",
            "baseName": "created_at",
            "type": "number",
            "format": "int64"
        },
        {
            "name": "description_drop",
            "baseName": "description_drop",
            "type": "Drop",
            "format": ""
        },
        {
            "name": "voting",
            "baseName": "voting",
            "type": "WaveVotingConfig",
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
        },
        {
            "name": "contributors_overview",
            "baseName": "contributors_overview",
            "type": "Array<WaveContributorOverview>",
            "format": ""
        },
        {
            "name": "subscribed_actions",
            "baseName": "subscribed_actions",
            "type": "Array<WaveSubscriptionTargetAction>",
            "format": ""
        },
        {
            "name": "metrics",
            "baseName": "metrics",
            "type": "WaveMetrics",
            "format": ""
        }    ];

    static getAttributeTypeMap() {
        return Wave.attributeTypeMap;
    }

    public constructor() {
    }
}

