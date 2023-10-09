import { loadEnv, unload } from '../secrets';
import { NextGenAllowlist, NextGenCollection } from '../entities/INextGen';

export const handler = async () => {
  console.log(new Date(), '[RUNNING NEXTGEN LOOP]');
  await loadEnv([NextGenAllowlist, NextGenCollection]);
  await unload();
  console.log(new Date(), '[NEXTGEN LOOP COMPLETE]');
};
