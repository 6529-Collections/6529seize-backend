import { loadEnv, unload } from '../secrets';
import {doDummyStuff} from "../dummy";
import {Dummy} from "../entities/IDummy";

export const handler = async (event?: any, context?: any) => {
  console.log(new Date(), '[RUNNING DUMMY LOOP]');
  await loadEnv([Dummy]);
  await doDummyStuff();
  await unload();
  console.log(new Date(), '[DUMMY LOOP COMPLETE]');
};
