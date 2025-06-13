import 'source-map-support/register';
import { InteractiveMode } from './modes/interactive-mode';
import path from 'path';

async function main() {
  try {
    const app = new InteractiveMode(path.resolve(__dirname, '../../config.json'));
    await app.run();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('\nInteractive Module Error:', message);
    process.exit(1);
  }
}

main();
