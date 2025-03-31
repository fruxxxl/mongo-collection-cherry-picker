import 'source-map-support/register';

import { parseCommandLineArgs } from './utils/index';

import { MongoDBApp } from './core/mongodb-app';

async function main() {
  try {
    const args = parseCommandLineArgs();

    const app = new MongoDBApp(args);
    await app.run();
  } catch (error) {
    console.error('Run error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main().catch(console.error);
