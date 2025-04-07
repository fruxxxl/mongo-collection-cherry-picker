import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import { AppConfig, BackupMetadata, ConnectionConfig } from '../types';

import { formatFilename } from '../utils/formatter';

/**
 * Handles the creation and management of MongoDB backups using mongodump.
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
   * Creates a backup archive (.gz) for a specified MongoDB source.
   * Determines whether to run mongodump locally or remotely via SSH based on the source configuration.
   * Handles collection filtering (all, include, exclude).
   * Generates a metadata file (.json) alongside the backup archive.
   *
   * @param source - The configuration of the source MongoDB connection.
   * @param selectedCollections - An array of collection names to include (used when selectionMode is 'include').
   * @param excludedCollections - An array of collection names to exclude (used when selectionMode is 'exclude').
   * @param selectionMode - Specifies how collections are selected for backup ('all', 'include', 'exclude').
   * @returns A promise that resolves with the absolute path to the created backup archive file.
   * @throws An error if the backup process fails.
   */
  async createBackup(
    source: ConnectionConfig,
    selectedCollections: string[],
    excludedCollections: string[],
    selectionMode: 'all' | 'include' | 'exclude',
  ): Promise<string> {
    const date = new Date().toISOString().split('T')[0];
    const filename = formatFilename(this.config.filenameFormat, date, source.name);
    const backupDir = path.resolve(this.config.backupDir);

    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
      console.log(`Created backup directory: ${backupDir}`);
    }

    const filePath = path.join(backupDir, filename);
    console.log(`\nBackup will be saved to: ${filePath}`);

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

    if (selectionMode === 'include' && selectedCollections.length > 0) {
      selectedCollections.forEach((coll) => baseArgs.push(`--collection=${coll}`));
    } else if (selectionMode === 'exclude' && excludedCollections.length > 0) {
      excludedCollections.forEach((coll) => baseArgs.push(`--excludeCollection=${coll}`));
    }

    baseArgs.push('--gzip');

    try {
      const mongodumpPath = this.config.mongodumpPath || 'mongodump';

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
        console.log(`Remote command to execute: ${remoteCommand}`);

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

        const outputFile = fs.createWriteStream(filePath);
        console.log(`Executing SSH command: ssh ${sshArgs.slice(0, -1).join(' ')} "${remoteCommand}"`);

        const sshProcess = spawn('ssh', sshArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

        sshProcess.stdout.pipe(outputFile);

        let errorOutput = '';
        sshProcess.stderr.on('data', (data) => {
          const errorChunk = data.toString();
          console.warn(`SSH stderr: ${errorChunk.trim()}`);
          errorOutput += errorChunk;
        });

        const exitCode = await new Promise<number>((resolve, reject) => {
          outputFile.on('close', () => {
            sshProcess.on('close', resolve);
          });
          sshProcess.on('error', (err) => {
            console.error(`Failed to start SSH process: ${err.message}`);
            reject(new Error(`Failed to start SSH process: ${err.message}`));
          });
          outputFile.on('error', (err) => {
            console.error(`Error writing to local backup file: ${err.message}`);
            sshProcess.kill();
            reject(new Error(`Error writing to local backup file: ${err.message}`));
          });
          sshProcess.on('close', (code) => {
            if (!outputFile.writableEnded) {
              resolve(code ?? 1);
            }
          });
        });

        if (exitCode !== 0) {
          throw new Error(`SSH mongodump execution finished with exit code ${exitCode}. Stderr: ${errorOutput}`);
        }

        console.log('SSH backup process completed successfully.');
      } else {
        const directArgs = [...baseArgs];
        directArgs.push(`--archive=${filePath}`);

        console.log('\nExecuting local mongodump command:');
        const commandString = `${mongodumpPath} ${directArgs.join(' ')}`;
        console.log(`${commandString}\n`);

        const dumpProcess = spawn(mongodumpPath, directArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

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
        console.log('Local backup process completed successfully.');
      }

      const backupMetadata: BackupMetadata = {
        source: source.name,
        database: source.database,
        includedCollections: selectionMode === 'include' ? selectedCollections : [],
        selectionMode: selectionMode,
        excludedCollections: selectionMode === 'exclude' ? excludedCollections : undefined,
        timestamp: Date.now(),
        date: new Date().toISOString(),
        archivePath: filename,
      };

      const metadataPath = `${filePath}.json`;
      fs.writeFileSync(metadataPath, JSON.stringify(backupMetadata, null, 2));
      console.log(`Backup metadata saved to: ${metadataPath}`);

      return filePath;
    } catch (error: any) {
      console.error(`\n✖ Error creating backup: ${error.message}`);
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
   * Retrieves a list of backup archive files (.gz) from the configured backup directory.
   * Files are sorted by name in descending order (newest first).
   *
   * @returns An array of backup filenames found in the backup directory.
   */
  getBackupFiles(): string[] {
    const backupDir = path.resolve(this.config.backupDir);
    if (!fs.existsSync(backupDir)) {
      console.log(`Backup directory not found: ${backupDir}`);
      return [];
    }

    try {
      return fs
        .readdirSync(backupDir)
        .filter((file) => file.endsWith('.gz'))
        .sort()
        .reverse();
    } catch (error: any) {
      console.error(`Error reading backup directory ${backupDir}: ${error.message}`);
      return [];
    }
  }

  /**
   * Loads backup metadata from the .json file corresponding to a given archive filename.
   *
   * @param archiveFilename - The filename of the backup archive (e.g., "backup_2023-10-27_prod.gz").
   * @returns The parsed BackupMetadata object.
   * @throws An error if the metadata file is not found or cannot be parsed.
   */
  loadBackupMetadata(archiveFilename: string): BackupMetadata {
    const backupDir = path.resolve(this.config.backupDir);
    const metadataPath = path.join(backupDir, `${archiveFilename}.json`);

    if (!fs.existsSync(metadataPath)) {
      console.error(`Attempted to load metadata from: ${metadataPath}`);
      throw new Error(`Backup metadata file not found: ${metadataPath}`);
    }

    try {
      const metadataJson = fs.readFileSync(metadataPath, 'utf8');
      return JSON.parse(metadataJson) as BackupMetadata;
    } catch (error: any) {
      throw new Error(`Failed to read or parse metadata file ${metadataPath}: ${error.message}`);
    }
  }
}
