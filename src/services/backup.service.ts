/* eslint-disable quotes */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import type { AppConfig, BackupMetadata, ConnectionConfig } from '../types';
import { formatFilename, getFormattedTimestamps, objectIdFromTimestamp } from '../utils/formatter';

/**
 * Handles the execution of mongodump command for creating MongoDB backups.
 * Supports both direct database connections and connections via SSH tunnel.
 */
export class BackupService {
  private config: AppConfig;

  /**
   * Creates an instance of BackupService.
   * @param config - The application configuration.
   */
  constructor(config: AppConfig) {
    this.config = config;
  }

  /**
   * Executes the mongodump command to create a backup archive (.gz).
   * Determines whether to run mongodump locally or remotely via SSH based on the source configuration.
   * Handles collection filtering based on provided arguments.
   *
   * @param source - The configuration of the source MongoDB connection.
   * @param selectedCollections - An array of collection names for the `--collection` flag (should be empty if mode is 'exclude' or 'all').
   * @param excludedCollections - An array of collection names for the `--excludeCollection` flag (used when mode is 'exclude').
   * @param mode - Specifies the effective mode for the mongodump command ('all', 'include', 'exclude').
   * @param startTime - Optional start time to filter documents using --query on _id.
   * @returns A promise that resolves with the absolute path to the created backup archive file.
   * @throws An error if the backup process fails.
   */
  async createBackup(
    source: ConnectionConfig,
    selectedCollections: string[],
    excludedCollections: string[],
    mode: 'all' | 'include' | 'exclude',
    startTime?: Date,
  ): Promise<string> {
    const now = new Date();
    const { date, time, datetime } = getFormattedTimestamps(now);

    const filename = formatFilename(
      this.config.filenameFormat || 'backup_{datetime}_{source}.gz',
      date,
      time,
      datetime,
      source.name,
    );
    const backupDir = path.resolve(this.config.backupDir);
    const filePath = path.join(backupDir, filename);

    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
      console.log(`Created backup directory: ${backupDir}`);
    }

    console.log(`\nBackup archive will be saved to: ${filePath}`);

    const baseArgs: string[] = [];

    // --- Connection Arguments ---
    if (source.ssh) {
      // SSH Execution: Ignore URI, use separate fields for mongodump on remote host
      console.log(`[${source.name}] SSH mode detected. Building mongodump args from separate fields.`);

      // Важно: Для SSH mongodump должен подключаться к MongoDB на удаленной машине.
      // Хост и порт MongoDB могут отличаться от хоста/порта SSH.
      // Используем поля из конфига source, а не source.ssh для MongoDB.
      if (!source.database) {
        throw new Error(`[${source.name}] Database name ('database') is required in config for SSH backup.`);
      }
      baseArgs.push(`--db=${source.database}`);

      // Пытаемся извлечь хост/порт из URI, если отдельные поля не заданы
      let mongoHost = source.host;
      let mongoPort = source.port;
      const requiresAuthArgs = true; // Assume we need user/pass unless URI parsing fails specifically

      if (!mongoHost && source.uri) {
        try {
          const parsedUri = new URL(source.uri);
          // Простой парсинг, может не покрыть все случаи replica set URI
          mongoHost = parsedUri.hostname; // Или parsedUri.host если включает порт
          mongoPort = parseInt(parsedUri.port, 10) || undefined; // Используем порт из URI если есть
          console.log(
            `[${source.name}] Extracted MongoDB host/port from URI for SSH: ${mongoHost}:${mongoPort || 'default'}`,
          );
          // Если URI есть, предполагаем, что mongodump сам разберется с auth из него,
          // но это рискованно. Лучше требовать явные поля.
          // Пока оставим requiresAuthArgs = true
        } catch (e) {
          console.warn(
            `[${source.name}] Could not parse MongoDB host/port from URI. Please define 'host' and 'port' explicitly in config for SSH backup.`,
          );
        }
      }

      if (mongoHost) baseArgs.push(`--host=${mongoHost}`);
      if (mongoPort) baseArgs.push(`--port=${mongoPort}`);

      // Добавляем аутентификацию, если она есть в конфиге
      if (source.username) baseArgs.push(`--username=${source.username}`);
      else if (requiresAuthArgs) console.warn(`[${source.name}] SSH Backup: 'username' not found in config.`);

      if (source.password) baseArgs.push(`--password=${source.password}`);
      else if (requiresAuthArgs && source.username)
        console.warn(`[${source.name}] SSH Backup: 'password' not found in config for user ${source.username}.`);

      const authDb = source.authenticationDatabase || source.authSource; // Prefer explicit fields
      if (authDb) {
        baseArgs.push(`--authenticationDatabase=${authDb}`);
      } else if (requiresAuthArgs && source.username) {
        // Пытаемся извлечь из URI как fallback
        let authSourceFromUri: string | null = null;
        if (source.uri) {
          try {
            const parsedUri = new URL(source.uri);
            authSourceFromUri = parsedUri.searchParams.get('authSource');
          } catch {
            /* ignore parsing error */
          }
        }
        if (authSourceFromUri) {
          baseArgs.push(`--authenticationDatabase=${authSourceFromUri}`);
          console.log(`[${source.name}] Extracted authSource from URI: ${authSourceFromUri}`);
        } else {
          console.warn(
            `[${source.name}] SSH Backup: 'authenticationDatabase' or 'authSource' not found in config or URI for user ${source.username}. Assuming 'admin' or target db might work.`,
          );
          // Можно добавить базу по умолчанию, например 'admin', если не найдено
          // baseArgs.push(`--authenticationDatabase=admin`);
        }
      }
    } else {
      // Local Execution: Use URI if available, otherwise separate fields
      if (source.uri) {
        baseArgs.push(`--uri="${source.uri}"`);

        baseArgs.push(`--db=${source.database}`);
      } else {
        // Fallback to separate fields if no URI
        if (!source.database) {
          throw new Error(
            `[${source.name}] Database name ('database') is required for local backup if URI is not provided.`,
          );
        }
        baseArgs.push(`--db=${source.database}`);
        if (source.host) baseArgs.push(`--host=${source.host}`);
        if (source.port) baseArgs.push(`--port=${source.port}`);
        if (source.username) baseArgs.push(`--username=${source.username}`);
        if (source.password) baseArgs.push(`--password=${source.password}`);
        const authDb = source.authenticationDatabase || source.authSource || source.database; // Default to target db if not specified
        if (authDb) baseArgs.push(`--authenticationDatabase=${authDb}`);
      }
    }
    // --- End Connection Arguments ---

    // --- Filtering Arguments ---
    let queryValue: string | undefined = undefined;

    if (startTime) {
      if (mode !== 'include' || selectedCollections.length !== 1) {
        throw new Error(
          'Internal error: startTime provided but mode is not "include" or selectedCollections count is not 1.',
        );
      }
      const collectionName = selectedCollections[0];
      baseArgs.push('--collection', collectionName);
      try {
        const startObjectId = objectIdFromTimestamp(startTime);
        queryValue = JSON.stringify({ _id: { $gte: { $oid: startObjectId } } });
        console.log(
          `Applying time filter to collection "${collectionName}": including documents with _id >= ${startObjectId} (time >= ${startTime.toISOString()})`,
        );
      } catch (e) {
        console.error(`Error generating ObjectId for time filter: ${e instanceof Error ? e.message : String(e)}`);
        throw new Error('Failed to create time filter query.');
      }
    } else {
      if (mode === 'exclude' && excludedCollections.length > 0) {
        excludedCollections.forEach((coll) => baseArgs.push('--excludeCollection', coll));
        console.log(`[${source.name}] Backup mode: excluding ${excludedCollections.length} collection(s)`);
      } else {
        console.log(`[${source.name}] Backup mode: all collections`);
      }
    }
    // --- End Filtering Arguments ---

    baseArgs.push('--gzip');

    const mongodumpPath = this.config.mongodumpPath || 'mongodump';
    let commandStringForLog = '';

    try {
      if (source.ssh) {
        // --- SSH Execution ---
        console.log(`Executing mongodump via SSH to ${source.ssh.host}...`);

        const remoteArgs = [...baseArgs];
        if (queryValue) {
          const remoteQueryValue = `'${queryValue}'`;
          remoteArgs.push('--query', remoteQueryValue);
          console.log(`DEBUG: Adding remote query args: --query ${remoteQueryValue}`);
        }
        remoteArgs.push('--archive');

        const remoteCommandParts = [mongodumpPath];
        remoteArgs.forEach((arg) => {
          if (arg.includes(' ') || arg.includes('"') || arg.includes("'") || arg.includes('$') || arg.includes('=')) {
            if (arg.startsWith("'") && arg.endsWith("'") && arg.includes('{') && arg.includes('}')) {
              remoteCommandParts.push(arg);
            } else if (arg.startsWith('--uri="')) {
              remoteCommandParts.push(arg);
            } else {
              remoteCommandParts.push(`"${arg.replace(/"/g, '\\"')}"`);
            }
          } else {
            remoteCommandParts.push(arg);
          }
        });
        const remoteCommand = remoteCommandParts.join(' ');

        commandStringForLog = `ssh ... "${remoteCommand}" > ${filePath}`;
        console.log(
          `Executing remote mongodump command via SSH:\n${remoteCommand}\n(Output piped locally to ${path.basename(filePath)})`,
        );

        const privateKeyPath = source.ssh.privateKey.startsWith('~')
          ? path.join(os.homedir(), source.ssh.privateKey.substring(1))
          : source.ssh.privateKey;

        const sshArgs = [
          '-i',
          privateKeyPath,
          '-p',
          String(source.ssh.port || 22),
          `${source.ssh.username}@${source.ssh.host}`,
          remoteCommand,
        ];

        console.log(`Spawning SSH process: ssh ${sshArgs.slice(0, -1).join(' ')} "..."`);

        const sshProcess = spawn('ssh', sshArgs, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });

        const fileStream = fs.createWriteStream(filePath);
        sshProcess.stdout.pipe(fileStream);

        let errorOutput = '';
        sshProcess.stderr.on('data', (data) => {
          const errorChunk = data.toString();
          console.warn(`SSH/mongodump: ${errorChunk.trim()}`);
          errorOutput += errorChunk;
        });

        const exitCode = await new Promise<number>((resolve, reject) => {
          sshProcess.on('close', resolve);
          sshProcess.on('error', (err) => {
            console.error(`Failed to start SSH process: ${err.message}`);
            reject(new Error(`Failed to start SSH process: ${err.message}`));
          });
          fileStream.on('error', (err) => {
            console.error(`Error writing backup file: ${err.message}`);
            reject(new Error(`Error writing backup file: ${err.message}`));
          });
          fileStream.on('finish', () => {
            console.log(`[${source.name}] Backup data stream finished writing to file.`);
          });
        });

        if (exitCode !== 0) {
          throw new Error(`SSH mongodump execution finished with exit code ${exitCode}. Stderr: ${errorOutput}`);
        }
        console.log(`[${source.name}] SSH mongodump process completed successfully.`);
      } else {
        // --- Local Execution ---
        const directArgs = [...baseArgs];
        if (queryValue) {
          directArgs.push('--query', queryValue);
        }
        directArgs.push(`--archive=${filePath}`);

        commandStringForLog = `${mongodumpPath} ${directArgs.map((arg) => (arg.includes(' ') || arg.includes("'") || arg.includes('"') ? `"${arg.replace(/"/g, '\\"')}"` : arg)).join(' ')}`;
        console.log(`\nExecuting local mongodump command:\n${commandStringForLog}\n`);

        const dumpProcess = spawn(mongodumpPath, directArgs, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });

        let errorOutput = '';
        dumpProcess.stderr.on('data', (data) => {
          const errorChunk = data.toString();
          console.warn(`mongodump: ${errorChunk.trim()}`);
          errorOutput += errorChunk;
        });

        const exitCode = await new Promise<number>((resolve, reject) => {
          dumpProcess.on('close', resolve);
          dumpProcess.on('error', (err) => {
            console.error(`Failed to start local mongodump process: ${err.message}`);
            reject(new Error(`Failed to start local mongodump process: ${err.message}`));
          });
        });

        if (exitCode !== 0) {
          throw new Error(`Local mongodump finished with exit code ${exitCode}. Stderr: ${errorOutput}`);
        }
        console.log(`[${source.name}] Local mongodump process completed successfully.`);
      }

      return filePath;
    } catch (error: any) {
      console.error(`\n✖ Error creating backup: ${error.message}`);
      console.error(`Failed command (approximate): ${commandStringForLog}`);
      if (fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
          console.log(`Cleaned up incomplete backup file: ${filePath}`);
        } catch (cleanupError: any) {
          console.error(`Failed to cleanup incomplete backup file ${filePath}: ${cleanupError.message}`);
        }
      }
      throw error;
    }
  }

  /**
   * Loads backup metadata from the .json file corresponding to a backup archive.
   * @param backupFilename - The filename of the backup archive (e.g., backup_....gz).
   * @returns The parsed BackupMetadata object.
   * @throws An error if the metadata file is not found or cannot be parsed.
   */
  loadBackupMetadata(backupFilename: string): BackupMetadata {
    const metadataPath = path.join(this.config.backupDir, `${backupFilename}.json`);
    if (!fs.existsSync(metadataPath)) {
      throw new Error(`Metadata file not found: ${metadataPath}`);
    }
    try {
      const metadataContent = fs.readFileSync(metadataPath, 'utf-8');
      const metadata = JSON.parse(metadataContent) as BackupMetadata;
      if (!metadata.source || !metadata.timestamp || !metadata.archivePath) {
        throw new Error('Metadata file is missing required fields (source, timestamp, archivePath).');
      }
      metadata.archivePath = path.basename(metadata.archivePath);
      return metadata;
    } catch (error: any) {
      throw new Error(`Failed to load or parse metadata file ${metadataPath}: ${error.message}`);
    }
  }

  /**
   * Lists backup archive files (.gz) in the backup directory, sorted newest first.
   * @returns An array of backup filenames.
   */
  getBackupFiles(): string[] {
    const backupDir = path.resolve(this.config.backupDir);
    if (!fs.existsSync(backupDir)) {
      return [];
    }
    try {
      const files = fs.readdirSync(backupDir);
      return files
        .filter((file) => file.endsWith('.gz') && !file.startsWith('.'))
        .map((file) => {
          try {
            return { name: file, time: fs.statSync(path.join(backupDir, file)).mtime.getTime() };
          } catch {
            return { name: file, time: 0 };
          }
        })
        .sort((a, b) => b.time - a.time)
        .map((file) => file.name);
    } catch (error: any) {
      console.error(`Error reading backup directory ${backupDir}: ${error.message}`);
      return [];
    }
  }
}
