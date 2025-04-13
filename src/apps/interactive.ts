import 'source-map-support/register';
import { InteractiveModule } from '../modules/interactive-module';

async function main() {
  try {
    const app = new InteractiveModule('../../config.json');
    await app.run();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('\nInteractive Module Error:', message);
    process.exit(1);
  }
}

main();
