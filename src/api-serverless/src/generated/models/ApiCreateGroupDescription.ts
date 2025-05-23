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

import { ApiGroupCicFilter } from '../models/ApiGroupCicFilter';
import { ApiGroupLevelFilter } from '../models/ApiGroupLevelFilter';
import { ApiGroupOwnsNft } from '../models/ApiGroupOwnsNft';
import { ApiGroupRepFilter } from '../models/ApiGroupRepFilter';
import { ApiGroupTdhFilter } from '../models/ApiGroupTdhFilter';
import { HttpFile } from '../http/http';

export class ApiCreateGroupDescription {
    'tdh': ApiGroupTdhFilter;
    'rep': ApiGroupRepFilter;
    'cic': ApiGroupCicFilter;
    'level': ApiGroupLevelFilter;
    'owns_nfts': Array<ApiGroupOwnsNft>;
    'identity_addresses': Array<string> | null;
    'excluded_identity_addresses': Array<string> | null;

    static readonly discriminator: string | undefined = undefined;

    static readonly attributeTypeMap: Array<{name: string, baseName: string, type: string, format: string}> = [
        {
            "name": "tdh",
            "baseName": "tdh",
            "type": "ApiGroupTdhFilter",
            "format": ""
        },
        {
            "name": "rep",
            "baseName": "rep",
            "type": "ApiGroupRepFilter",
            "format": ""
        },
        {
            "name": "cic",
            "baseName": "cic",
            "type": "ApiGroupCicFilter",
            "format": ""
        },
        {
            "name": "level",
            "baseName": "level",
            "type": "ApiGroupLevelFilter",
            "format": ""
        },
        {
            "name": "owns_nfts",
            "baseName": "owns_nfts",
            "type": "Array<ApiGroupOwnsNft>",
            "format": ""
        },
        {
            "name": "identity_addresses",
            "baseName": "identity_addresses",
            "type": "Array<string>",
            "format": ""
        },
        {
            "name": "excluded_identity_addresses",
            "baseName": "excluded_identity_addresses",
            "type": "Array<string>",
            "format": ""
        }    ];

    static getAttributeTypeMap() {
        return ApiCreateGroupDescription.attributeTypeMap;
    }

    public constructor() {
    }
}

