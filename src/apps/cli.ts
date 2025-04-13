import 'source-map-support/register';
import { CLIModule } from '../modules/cli-module';

async function main() {
  try {
    const app = new CLIModule('../../config.json');
    await app.run();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('\nCLI Module Error:', message);
    process.exit(1);
  }
}

main();
