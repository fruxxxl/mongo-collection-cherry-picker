import * as fs from 'fs';
import * as path from 'path';
import type { AppConfig, CommandLineArgs } from '../types';
import { AppConfigSchema } from '../zod-schemas/config.schema';

/**
 * Parses command line arguments passed to the application.
 * Supports arguments for configuration path, mode (backup/restore),
 * source/target connections, backup options, time filter, and interactive mode flag.
 *
 * @returns An object conforming to the CommandLineArgs interface.
 */
export function parseCommandLineArgs(): CommandLineArgs {
  const args = process.argv.slice(2);

  let mode: 'backup' | 'restore' | undefined;
  let source: string | undefined;
  let backupMode: 'all' | 'include' | 'exclude' | undefined;
  let collections: string[] | undefined;
  let preset: string | undefined;
  let backupFile: string | undefined;
  let target: string | undefined;
  let drop: boolean = false;
  let interactive: boolean | undefined = undefined;
  let sinceTime: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--backup' || arg === '--mode=backup') {
      mode = 'backup';
      continue;
    }
    if (arg === '--restore' || arg === '--mode=restore') {
      mode = 'restore';
      continue;
    }

    if (arg.startsWith('--source=')) {
      source = arg.split('=')[1];
      continue;
    }

    if (arg.startsWith('--backupMode=')) {
      const modeValue = arg.split('=')[1];
      if (['all', 'include', 'exclude'].includes(modeValue)) {
        backupMode = modeValue as 'all' | 'include' | 'exclude';
      } else {
        console.warn(`Invalid --backupMode value: ${modeValue}. Using default.`);
      }
      continue;
    }

    if (arg.startsWith('--collections=')) {
      collections = arg
        .split('=')[1]
        .split(',')
        .map((c) => c.trim())
        .filter((c) => c);
      continue;
    }

    if (arg.startsWith('--preset=')) {
      preset = arg.split('=')[1];
      continue;
    }

    if (arg.startsWith('--file=') || arg.startsWith('--backupFile=')) {
      backupFile = arg.split('=')[1];
      continue;
    }

    if (arg.startsWith('--target=')) {
      target = arg.split('=')[1];
      continue;
    }

    if (arg === '--drop') {
      drop = true;
      continue;
    }

    if (arg === '--interactive' || arg === 'interactive') {
      interactive = true;
      continue;
    }

    if (arg.startsWith('--since-time=')) {
      sinceTime = arg.split('=')[1];
      continue;
    }
    if (arg === '--since-time' && i + 1 < args.length) {
      sinceTime = args[i + 1];
      i++;
      continue;
    }

    if (arg.startsWith('--')) {
      console.warn(`Warning: Unknown argument detected: ${arg}`);
    }
  }

  let finalInteractive: boolean;
  if (interactive === true) {
    finalInteractive = true;
  } else if (interactive === false) {
    finalInteractive = false;
  } else {
    finalInteractive = !(mode || preset);
  }

  if (!finalInteractive) {
    if (mode === 'backup' && !source && !preset) {
      console.error('Error: --source or --preset is required for backup mode in non-interactive run.');
      process.exit(1);
    }
    if (mode === 'restore' && !target && !preset) {
      console.error('Error: --target or --preset is required for restore mode in non-interactive run.');
      process.exit(1);
    }
    if (mode === 'restore' && !backupFile && !preset) {
      console.error('Error: --backupFile is required for restore mode when not using a preset.');
      process.exit(1);
    }
  }

  return {
    mode: finalInteractive ? undefined : mode,
    interactive: finalInteractive,
    source,
    backupMode,
    collections,
    preset,
    backupFile,
    target,
    drop,
    sinceTime,
  };
}

/**
 * Loads the application configuration from a JSON file.
 * Validates the configuration against the AppConfigSchema.
 *
 * @param configPath - The path to the configuration file.
 * @returns The validated application configuration object.
 * @throws An error if the file cannot be read, parsed, or validated.
 */
export function loadConfig(configPath: string): AppConfig {
  try {
    const absolutePath = path.resolve(configPath);
    console.log(`Loading configuration from: ${absolutePath}`);
    if (!fs.existsSync(absolutePath)) {
      throw new Error(`Configuration file not found at ${absolutePath}`);
    }
    const configJson = fs.readFileSync(absolutePath, 'utf8');
    const configData = JSON.parse(configJson);

    const validationResult = AppConfigSchema.safeParse(configData);
    if (!validationResult.success) {
      console.error('Configuration validation failed:');
      validationResult.error.errors.forEach((err) => {
        console.error(`  Path: ${err.path.join('.') || '.'}, Message: ${err.message}`);
      });
      throw new Error('Invalid configuration file structure.');
    }

    console.log('Configuration loaded and validated successfully.');
    return validationResult.data;
  } catch (error: any) {
    console.error(`Error loading or parsing configuration file "${configPath}": ${error.message}`);
    throw error;
  }
}

export function formatDate(date: Date): string {
  return date.toLocaleString('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function formatSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(2)} ${units[unitIndex]}`;
}

/**
 * Saves the updated presets array back to the configuration file.
 * Reads the existing config, updates the presets, and writes it back.
 * **Note:** This performs a full read/write cycle. Consider partial updates for large configs if needed.
 *
 * @param updatedConfig - The AppConfig object containing the potentially modified presets array.
 * @param configPath - The path to the configuration file (defaults to './config.json').
 * @throws An error if reading or writing the config file fails.
 */
export function savePresets(updatedConfig: AppConfig, configPath: string = './config.json'): void {
  try {
    const absolutePath = path.resolve(configPath);
    const configString = JSON.stringify(updatedConfig, null, 2);
    fs.writeFileSync(absolutePath, configString, 'utf8');
    console.log(`Configuration presets saved successfully to: ${absolutePath}`);
  } catch (error: any) {
    console.error(`Error saving presets to configuration file "${configPath}": ${error.message}`);
    throw error;
  }
}
