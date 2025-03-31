import * as fs from 'fs';
import * as path from 'path';
import { AppConfig } from '../types';
import { AppConfigSchema } from '../config/config.schema';

export function parseCommandLineArgs(): {
  configPath: string;
  mode?: 'backup' | 'restore';
  source?: string;
  backupMode?: 'all' | 'include' | 'exclude';
  collections?: string[];
  backupFile?: string;
  target?: string;
  interactive?: boolean;
} {
  const args = process.argv.slice(2);
  let configPath = './config.json';
  let mode: 'backup' | 'restore' | undefined;
  let source: string | undefined;
  let backupMode: 'all' | 'include' | 'exclude' | undefined;
  let collections: string[] | undefined;
  let backupFile: string | undefined;
  let target: string | undefined;
  let interactive = true; // По умолчанию интерактивный режим

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config' && i + 1 < args.length) {
      configPath = args[i + 1];
      continue;
    }

    if (args[i].startsWith('--config=')) {
      configPath = args[i].split('=')[1];
      continue;
    }

    if (args[i] === '--backup') {
      mode = 'backup';
      continue;
    }

    if (args[i] === '--restore') {
      mode = 'restore';
      continue;
    }

    if (args[i].startsWith('--source=')) {
      source = args[i].split('=')[1];
      continue;
    }

    if (args[i].startsWith('--mode=')) {
      const modeValue = args[i].split('=')[1];
      if (['all', 'include', 'exclude'].includes(modeValue)) {
        backupMode = modeValue as 'all' | 'include' | 'exclude';
      }
      continue;
    }

    if (args[i].startsWith('--collections=')) {
      collections = args[i].split('=')[1].split(',');
      continue;
    }

    if (args[i].startsWith('--file=')) {
      backupFile = args[i].split('=')[1];
      continue;
    }

    if (args[i].startsWith('--target=')) {
      target = args[i].split('=')[1];
      continue;
    }

    if (args[i] === '--no-interactive') {
      interactive = false;
      continue;
    }
  }

  // Support different environments
  if (process.env.NODE_ENV && !configPath.includes('.')) {
    const envSuffix = process.env.NODE_ENV;
    const baseName = path.basename(configPath, path.extname(configPath));
    const ext = path.extname(configPath) || '.json';
    configPath = `${baseName}.${envSuffix}${ext}`;
  }

  return {
    configPath,
    mode,
    source,
    backupMode,
    collections,
    backupFile,
    target,
    interactive
  };
}

export function loadConfig(customConfigPath?: string): AppConfig {
  const { configPath } = customConfigPath
    ? { configPath: customConfigPath }
    : parseCommandLineArgs();

  if (!fs.existsSync(configPath)) {
    throw new Error(`Configuration file not found: ${configPath}`);
  }

  console.log(`Loading configuration from: ${configPath}`);

  const configData = fs.readFileSync(configPath, 'utf8');
  const configJson = JSON.parse(configData);

  console.log(`Configuration contains: ${Object.keys(configJson).join(', ')}`);
  console.log(`Presets: backup=${configJson.backupPresets?.length || 0}`);

  try {
    const validatedConfig = AppConfigSchema.parse(configJson);
    console.log(`After validation: backup=${validatedConfig.backupPresets?.length || 0}`);
    return validatedConfig;
  } catch (error) {
    throw new Error(
      `Invalid configuration file format: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export function formatDate(date: Date): string {
  return date.toLocaleString('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
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

export function savePresets(config: AppConfig): void {
  const { configPath } = parseCommandLineArgs();

  try {
    // Read existing configuration file
    if (fs.existsSync(configPath)) {
      fs.writeFileSync(configPath, JSON.stringify(config, null, 4));
      console.log(`Configuration saved to ${configPath}`);
    } else {
      console.error(`Configuration file ${configPath} not found`);
    }
  } catch (error) {
    console.error(`Error saving configuration: ${error}`);
  }
}
