import 'source-map-support/register';
import { InteractiveModule } from '../modules/interactive-module';
import path from 'path';

async function main() {
  try {
    const app = new InteractiveModule(path.resolve(__dirname, '../../config.json'));
    await app.run();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('\nInteractive Module Error:', message);
    process.exit(1);
  }
}

main();
