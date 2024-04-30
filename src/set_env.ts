import { prompt } from 'enquirer';
import { Logger } from './logging';
import { createDataSource } from './db';
import { DataSource } from 'typeorm';
import { Transaction } from './entities/ITransaction';
import { NFTOwner } from './entities/INFTOwner';
import { NFT } from './entities/INFT';
import { TDH, ConsolidatedTDH, TDHBlock } from './entities/ITDH';
import { loadEnv } from './secrets';

const logger = Logger.get('LOAD_ENV');

export async function setEnv() {
  await ask('Press Enter to start the script or Ctrl+C to exit', false, false);

  // const dbHost = await ask('Enter DB Host:', false, true);
  // let dbPort: any = await ask('Enter DB Port:', false, true);
  // while (isNaN(parseInt(dbPort))) {
  //   dbPort = await ask('Enter DB Port:', false, true);
  // }
  // dbPort = parseInt(dbPort);
  // const dbAdminUser = await ask('Enter DB Admin User:', false, true);
  // const dbAdminPassword = await ask('Enter DB Admin Password:', true, false);
  // const dbNewDB = await ask('Enter New DB Name:', false, true);
  // const dbNewUser = await ask('Enter New DB User:', false, true);
  // const dbNewUserPassword = await ask(
  //   'Enter New DB User Password:',
  //   true,
  //   true
  // );

  const dbHost = '127.0.0.1';
  const dbPort = 3306;
  const dbAdminUser = 'root';
  const dbAdminPassword = 'root';
  const dbNewDB = 'OM6529LITE2';
  const dbNewUser = '6529backend2';
  const dbNewUserPassword = 'backend9256';

  const dataSource = await createDataSource(
    dbHost,
    dbPort,
    dbAdminUser,
    dbAdminPassword
  );

  // Create new DB
  await performDbOperation(
    dataSource,
    'Creating new DB',
    `CREATE DATABASE ${dbNewDB}`
  );

  // Create new Write User
  await performDbOperation(
    dataSource,
    'Creating new Write User',
    `CREATE USER '${dbNewUser}'@'%' IDENTIFIED WITH 'mysql_native_password' BY '${dbNewUserPassword}'`
  );
  // Grant all privileges to new user
  await performDbOperation(
    dataSource,
    'Granting all privileges to Write User',
    `GRANT ALL PRIVILEGES ON ${dbNewDB}.* TO '${dbNewUser}'@'%'`
  );

  const dbNewUserRead = `${dbNewUser}-read`;
  const dbNewUserPasswordRead = `${dbNewUserPassword}-read`;

  // Create new Read User
  await performDbOperation(
    dataSource,
    'Creating new Read User',
    `CREATE USER '${dbNewUserRead}'@'%' IDENTIFIED WITH 'mysql_native_password' BY '${dbNewUserPasswordRead}'`
  );
  // Grant read privileges to new user
  await performDbOperation(
    dataSource,
    'Granting read privileges to Read User',
    `GRANT SELECT ON ${dbNewDB}.* TO '${dbNewUserRead}'@'%'`
  );

  await dataSource.destroy();

  // Update .env file
  const envFileContent = `
    DB_HOST='${dbHost}'
    DB_USER='${dbNewUser}'
    DB_PASS='${dbNewUserPassword}'
    DB_HOST_READ='${dbHost}'
    DB_USER_READ='${dbNewUser}-read'
    DB_PASS_READ='${dbNewUserPassword}-read'
    DB_PORT=${dbPort}
    DB_NAME='${dbNewDB}'
  `;

  const fs = require('fs');
  fs.writeFileSync('.env.lite', envFileContent);

  await loadEnv([Transaction, TDH, ConsolidatedTDH, NFT, NFTOwner, TDHBlock]);

  logger.info('Environment setup complete!');
  process.exit(0);
}

async function ask(question: string, password: boolean, required: boolean) {
  const answer: { response: string } = await prompt({
    type: password ? 'password' : 'input',
    name: 'response',
    message: question,
    required: required
  });
  return answer.response.trim();
}

async function performDbOperation(
  dataSource: DataSource,
  name: string,
  sql: string
) {
  console.log('executing', sql);
  try {
    logger.info(`${name}...`);
    await dataSource.query(sql);
    logger.info(`${name}...DONE`);
  } catch (e: any) {
    logger.error(`${name}...FAILED : ${e}`);
    process.exit(1);
  }
}

setEnv();
