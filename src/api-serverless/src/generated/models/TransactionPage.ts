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

import { Transaction } from '../models/Transaction';
import { HttpFile } from '../http/http';

export class TransactionPage {
    'data': Array<Transaction>;
    'count': number;
    'page': number;
    'next': string | null;

    static readonly discriminator: string | undefined = undefined;

    static readonly attributeTypeMap: Array<{name: string, baseName: string, type: string, format: string}> = [
        {
            "name": "data",
            "baseName": "data",
            "type": "Array<Transaction>",
            "format": ""
        },
        {
            "name": "count",
            "baseName": "count",
            "type": "number",
            "format": "int64"
        },
        {
            "name": "page",
            "baseName": "page",
            "type": "number",
            "format": "int64"
        },
        {
            "name": "next",
            "baseName": "next",
            "type": "string",
            "format": ""
        }    ];

    static getAttributeTypeMap() {
        return TransactionPage.attributeTypeMap;
    }

    public constructor() {
    }
}
