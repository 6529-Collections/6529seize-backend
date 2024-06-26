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

import { ProfileMin } from '../models/ProfileMin';
import { ProfileProxyAction } from '../models/ProfileProxyAction';
import { HttpFile } from '../http/http';

export class ProfileProxy {
    'id': string;
    'granted_to': ProfileMin;
    'created_at': number;
    'created_by': ProfileMin;
    'actions': Array<ProfileProxyAction>;

    static readonly discriminator: string | undefined = undefined;

    static readonly attributeTypeMap: Array<{name: string, baseName: string, type: string, format: string}> = [
        {
            "name": "id",
            "baseName": "id",
            "type": "string",
            "format": ""
        },
        {
            "name": "granted_to",
            "baseName": "granted_to",
            "type": "ProfileMin",
            "format": ""
        },
        {
            "name": "created_at",
            "baseName": "created_at",
            "type": "number",
            "format": ""
        },
        {
            "name": "created_by",
            "baseName": "created_by",
            "type": "ProfileMin",
            "format": ""
        },
        {
            "name": "actions",
            "baseName": "actions",
            "type": "Array<ProfileProxyAction>",
            "format": ""
        }    ];

    static getAttributeTypeMap() {
        return ProfileProxy.attributeTypeMap;
    }

    public constructor() {
    }
}

