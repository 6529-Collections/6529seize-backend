import { ALCHEMY_SETTINGS } from './constants';
import { Alchemy } from 'alchemy-sdk';
import { randomUUID } from 'crypto';
import { persistDummy } from './db';

export async function doDummyStuff() {
    const alchemy = new Alchemy({
        ...ALCHEMY_SETTINGS,
        apiKey: process.env.ALCHEMY_API_KEY
    });
    const address = '0xb8c2C29ee19D8307cb7255e1Cd9CbDE883A267d5';
    console.log(`[DUMMY LOOP]`, `[Resolving address ${address}]`);
    const resolvedName = await alchemy.core.lookupAddress(address);
    console.log(`[DUMMY LOOP]`, `[${address} resolved to ${resolvedName}]`);
    const uuid = randomUUID();
    console.log(`[DUMMY LOOP]`, `[Saving resolved name ${resolvedName} with UUID ${uuid}. Saving]`);
    await persistDummy({
        field_one: uuid,
        field_two: resolvedName
    })
    console.log(`[DUMMY LOOP]`, `[Resolved name ${resolvedName} with UUID ${uuid} saved]`);
}