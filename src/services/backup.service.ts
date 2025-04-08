import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import type { AppConfig, BackupMetadata, ConnectionConfig } from '../types';
import { formatFilename, getFormattedTimestamps } from '../utils/formatter';

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
   * @param selectionMode - Specifies the effective mode for the mongodump command ('all', 'exclude'). 'include' mode is transformed to 'exclude' by the caller.
   * @returns A promise that resolves with the absolute path to the created backup archive file.
   * @throws An error if the backup process fails.
   */
  async createBackup(
    source: ConnectionConfig,
    selectedCollections: string[],
    excludedCollections: string[],
    selectionMode: 'all' | 'exclude',
  ): Promise<string> {
    const now = new Date();
    const { datetime } = getFormattedTimestamps(now);

    const filename = formatFilename(
      this.config.filenameFormat || 'backup_{datetime}_{source}.gz',
      now.toISOString().split('T')[0],
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

    if (source.uri) {
      if (!source.ssh) {
        baseArgs.push(`--uri="${source.uri}"`);
      }
    } else {
      if (source.host) baseArgs.push(`--host=${source.host}`);
      if (source.port) baseArgs.push(`--port=${source.port}`);
      if (source.username) baseArgs.push(`--username=${source.username}`);
      if (source.password) baseArgs.push(`--password=${source.password}`);
      const authDb = source.authenticationDatabase || source.authSource || source.authDatabase;
      if (authDb) baseArgs.push(`--authenticationDatabase=${authDb}`);
    }

    if (source.database) {
      baseArgs.push(`--db=${source.database}`);
    } else {
      if (!source.uri) {
        throw new Error(`[${source.name}] Database name is required for backup if URI is not provided.`);
      }
    }

    if (selectionMode === 'exclude' && excludedCollections.length > 0) {
      excludedCollections.forEach((coll) => baseArgs.push(`--excludeCollection=${coll}`));
      console.log(`[${source.name}] Backup mode (effective): exclude collections: ${excludedCollections.join(', ')}`);
    } else {
      console.log(`[${source.name}] Backup mode (effective): all collections`);
    }

    baseArgs.push('--gzip');

    const mongodumpPath = this.config.mongodumpPath || 'mongodump';
    let commandStringForLog = '';

    try {
      if (source.ssh) {
        console.log(`Executing mongodump via SSH to ${source.ssh.host}...`);

        const remoteArgs = [...baseArgs];
        remoteArgs.push('--archive');

        if (source.uri) {
          remoteArgs.push(`--uri="${source.uri}"`);
        } else if (!baseArgs.some((arg) => arg.startsWith('--host=') || arg.startsWith('--port='))) {
          console.warn(
            `[${source.name}] Warning: SSH backup without URI might need host/port specified if remote mongodump isn't connecting to localhost.`,
          );
        }

        const remoteCommand = `${mongodumpPath} ${remoteArgs.join(' ')}`;
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

        const archiveWriteStream = fs.createWriteStream(filePath);
        const sshProcess = spawn('ssh', sshArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
        sshProcess.stdout.pipe(archiveWriteStream);

        let errorOutput = '';
        sshProcess.stderr.on('data', (data) => {
          const errorChunk = data.toString();
          console.warn(`mongodump stderr (ssh): ${errorChunk.trim()}`);
          errorOutput += errorChunk;
        });

        const exitCode = await new Promise<number>((resolve, reject) => {
          archiveWriteStream.on('error', (err) => {
            console.error(`Error writing local archive file ${filePath}: ${err.message}`);
            if (!sshProcess.killed) sshProcess.kill();
            reject(new Error(`Error writing local archive file: ${err.message}`));
          });
          archiveWriteStream.on('close', () => {
            console.log(`[${source.name}] SSH backup stream to ${path.basename(filePath)} closed.`);
            if (sshProcess.exitCode !== null) {
              resolve(sshProcess.exitCode);
            } else {
              sshProcess.on('close', resolve);
            }
          });
          sshProcess.on('error', (err) => {
            console.error(`Failed to start SSH process: ${err.message}`);
            reject(new Error(`Failed to start SSH process: ${err.message}`));
          });
          sshProcess.on('close', (code) => {
            if (!archiveWriteStream.writableEnded) {
              console.warn(`SSH process closed (code: ${code}) before file stream finished writing.`);
              archiveWriteStream.end(() => {
                resolve(code ?? 1);
              });
            }
          });
        });

        if (exitCode !== 0) {
          throw new Error(`SSH mongodump execution finished with exit code ${exitCode}. Stderr: ${errorOutput}`);
        }
        console.log(`[${source.name}] SSH mongodump process completed successfully.`);
      } else {
        const directArgs = [...baseArgs];
        directArgs.push(`--archive=${filePath}`);
        commandStringForLog = `${mongodumpPath} ${directArgs.map((arg) => (arg.includes(' ') ? `"${arg}"` : arg)).join(' ')}`;
        console.log(`\nExecuting local mongodump command:\n${commandStringForLog}\n`);

        const dumpProcess = spawn(mongodumpPath, directArgs, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });

        let errorOutput = '';
        dumpProcess.stderr.on('data', (data) => {
          const errorChunk = data.toString();
          console.warn(`mongodump stderr: ${errorChunk.trim()}`);
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
