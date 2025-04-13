import 'source-map-support/register';
import { CLIModule } from '../modules/cli-module';
import path from 'path';

async function main() {
  try {
    const app = new CLIModule(path.resolve(__dirname, '../../config.json'));
    await app.run();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('\nCLI Module Error:', message);
    process.exit(1);
  }
}

main();
