import type { CommandLineArgs } from '../types';
import { URLSearchParams } from 'url';

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

export function parseMongoUri(uri: string): {
  user?: string;
  password?: string;
  hosts: { host: string; port: number }[];
  database?: string;
  options: Record<string, string>;
} {
  const mongoUriRegex = /^mongodb:\/\/(?:([^:]+)(?::([^@]+))?@)?([^/?]+)(?:\/([^?]+))?(?:\?(.+))?$/;
  let match = uri.match(mongoUriRegex);

  if (!match) {
    const uriWithSlash = uri.includes('?') && !uri.includes('/?') ? uri.replace('?', '/?') : uri;
    const fallbackMatch = uriWithSlash.match(mongoUriRegex);
    if (!fallbackMatch) {
      // Consider using logger here if available globally or passed
      console.error('Failed to parse URI with regex:', uri);
      throw new Error('Invalid MongoDB URI format');
    }
    // Consider using logger here
    console.warn('Parsed URI using fallback with added slash.');
    match = fallbackMatch;
  }

  const [, user, password, hostString, database, optionString] = match!;

  const hosts = hostString.split(',').map((hostPort) => {
    const parts = hostPort.split(':');
    const host = parts[0];
    const port = parseInt(parts[1] || '27017', 10);
    if (isNaN(port)) {
      throw new Error(`Invalid port number in host string: ${hostPort}`);
    }
    return { host, port };
  });

  const options: Record<string, string> = {};
  if (optionString) {
    const params = new URLSearchParams(optionString);
    params.forEach((value, key) => {
      options[key] = value;
    });
  }

  return {
    user: user ? decodeURIComponent(user) : undefined,
    password: password ? decodeURIComponent(password) : undefined,
    hosts,
    database: database ? database.split('/')[0] : undefined,
    options,
  };
}
