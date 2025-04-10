import 'source-map-support/register';
import { parseCommandLineArgs } from './utils/index';
import { MongoDBApp } from './core/mongodb-app';

async function main() {
  try {
    const commandArgs = parseCommandLineArgs();

    const app = new MongoDBApp(commandArgs);
    await app.run();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('\nApplication Error:', message);
    process.exit(1);
  }
}

main();
