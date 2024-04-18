import { prompt } from 'enquirer';
import { Logger } from './logging';

const logger = Logger.get('START_SCRIPT');

export async function startScript() {
  await ask('Press Enter to start the script or Ctrl+C to exit', false, false);

  const dbHost = await ask('Enter DB Host:', false, true);
  const dbAdminUser = await ask('Enter DB Admin User:', false, true);
  const dbAdminPassword = await ask('Enter DB Admin Password:', true, true);
  const dbNewDB = await ask('Enter New DB Name:', false, true);
  const dbNewUser = await ask('Enter New DB User:', false, true);
  const dbNewUserPassword = await ask(
    'Enter New DB User Password:',
    true,
    true
  );

  // console.log('dbHost', dbHost);
  // console.log('dbAdminUser', dbAdminUser);
  // console.log('dbAdminPassword', dbAdminPassword);
  // console.log('dbNewUser', dbNewUser);
  // console.log('dbNewUserPassword', dbNewUserPassword);
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
