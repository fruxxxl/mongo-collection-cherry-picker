import { AppConfig, BackupMetadata, ConnectionConfig, RestoreOptions } from '../types/index';

import * as fs from 'fs';
import * as path from 'path';

import { MongoDBService } from './mongodb.service';
import { spawn } from 'child_process';
import os from 'os';

export class RestoreService {
  private config: AppConfig;

  constructor(config: AppConfig) {
    this.config = config;
  }

  /**
   * Restores a MongoDB database from a backup archive using mongorestore.
   * Handles both direct and SSH connections for the target.
   * Uses metadata to determine restore parameters.
   *
   * @param backupMetadata - The metadata loaded from the backup's .json file.
   * @param target - The configuration of the target MongoDB connection.
   * @param options - Restore options, like dropping the database first.
   * @returns A promise that resolves when the restore is complete.
   * @throws An error if the restore process fails.
   */
  async restoreBackup(
    backupMetadata: BackupMetadata,
    target: ConnectionConfig,
    options: RestoreOptions = {},
  ): Promise<void> {
    const backupDir = path.resolve(this.config.backupDir);
    const archivePath = path.join(backupDir, backupMetadata.archivePath);

    if (!fs.existsSync(archivePath)) {
      throw new Error(`Backup archive file not found: ${archivePath}`);
    }

    console.log(`\nStarting restore from: ${archivePath}`);
    console.log(`Target: ${target.name} (${target.database})`);

    // --- Build mongorestore arguments ---
    const baseArgs: string[] = [];

    // Add target connection details (URI or host/port/auth)
    // Similar logic as in BackupService, but for the target
    if (target.uri && !target.ssh) {
      baseArgs.push(`--uri="${target.uri}"`);
    } else if (!target.uri) {
      if (target.host) baseArgs.push(`--host=${target.host}`);
      if (target.port) baseArgs.push(`--port=${target.port}`);
      if (target.username) baseArgs.push(`--username=${target.username}`);
      if (target.password) baseArgs.push(`--password=${target.password}`);
      const authDb = target.authenticationDatabase || target.authSource || target.authDatabase;
      if (authDb) baseArgs.push(`--authenticationDatabase=${authDb}`);
    }

    // Specify the target database if not using URI with database name
    // Use --nsFrom / --nsTo to map the database from the archive to the target database
    const sourceDbName = backupMetadata.database; // Get source DB name from metadata
    const targetDbName = target.database; // Get target DB name from config

    if (targetDbName && sourceDbName) {
      // Use --nsFrom and --nsTo with the correct 'database.*' syntax
      baseArgs.push(`--nsFrom="${sourceDbName}.*"`); // Source DB and all its collections
      baseArgs.push(`--nsTo="${targetDbName}.*"`); // Target DB and all its collections
    } else if (targetDbName && !sourceDbName) {
      // Fallback if source DB name is missing in metadata (unlikely)
      console.warn(
        `Source database name missing in metadata for archive ${backupMetadata.archivePath}. Attempting restore using --db=${targetDbName}.`,
      );
      baseArgs.push(`--db=${targetDbName}`); // Fallback to --db
    } else if (!targetDbName && !target.uri?.includes('/')) {
      // Target DB must be specified somehow
      throw new Error(`[${target.name}] Target database name is required if not specified in URI or config.`);
    }
    // If targetDbName is not specified here but is in the URI, mongorestore should use the one from the URI.

    // Add archive and gzip arguments
    baseArgs.push('--gzip');
    baseArgs.push(`--archive=${archivePath}`); // For direct execution

    // Add options
    if (options.drop) {
      // --drop will drop the TARGET database before restoring
      baseArgs.push('--drop');
    }

    try {
      const mongorestorePath = this.config.mongorestorePath || 'mongorestore';

      if (target.ssh) {
        // --- SSH Execution ---
        // Similar logic to BackupService: mongorestore reads from stdin
        console.log(`Executing mongorestore via SSH to ${target.ssh.host}...`);

        const remoteArgs = [...baseArgs];
        // Remove --archive=path, replace with --archive (stdin)
        const archiveIndex = remoteArgs.findIndex((arg) => arg.startsWith('--archive='));
        if (archiveIndex > -1) {
          remoteArgs.splice(archiveIndex, 1);
          // Add --archive without value for stdin
          if (!remoteArgs.includes('--archive')) {
            // Ensure it's not added twice
            remoteArgs.push('--archive');
          }
        } else {
          // If --archive=path wasn't found, ensure --archive (stdin) is present
          if (!remoteArgs.includes('--archive')) {
            remoteArgs.push('--archive');
          }
        }

        // Remote command needs connection details
        if (target.uri) {
          remoteArgs.push(`--uri="${target.uri}"`);
        } else if (!baseArgs.some((arg) => arg.startsWith('--host=') || arg.startsWith('--port='))) {
          console.warn(`[${target.name}] Warning: SSH restore without URI might need host/port.`);
        }

        const remoteCommand = `${mongorestorePath} ${remoteArgs.join(' ')}`;
        console.log(`Remote command to execute: ${remoteCommand}`);

        const privateKeyPath = target.ssh.privateKey.startsWith('~')
          ? path.join(os.homedir(), target.ssh.privateKey.substring(1))
          : target.ssh.privateKey;

        const sshArgs = [
          '-i',
          privateKeyPath,
          '-p',
          String(target.ssh.port || 22),
          `${target.ssh.username}@${target.ssh.host}`,
          remoteCommand,
        ];

        const inputFile = fs.createReadStream(archivePath);
        console.log(`Executing SSH command: ssh ${sshArgs.slice(0, -1).join(' ')} "${remoteCommand}"`);

        const sshProcess = spawn('ssh', sshArgs, { stdio: ['pipe', 'pipe', 'pipe'] }); // stdin is piped

        // Pipe local archive file to remote mongorestore's stdin
        inputFile.pipe(sshProcess.stdin);

        let output = '';
        sshProcess.stdout.on('data', (data) => {
          const chunk = data.toString();
          console.log(`SSH stdout: ${chunk.trim()}`);
          output += chunk;
        });

        let errorOutput = '';
        sshProcess.stderr.on('data', (data) => {
          const errorChunk = data.toString();
          console.warn(`SSH stderr: ${errorChunk.trim()}`);
          errorOutput += errorChunk;
        });

        const exitCode = await new Promise<number>((resolve, reject) => {
          sshProcess.on('close', resolve);
          sshProcess.on('error', (err) => {
            console.error(`Failed to start SSH process: ${err.message}`);
            reject(new Error(`Failed to start SSH process: ${err.message}`));
          });
          inputFile.on('error', (err) => {
            console.error(`Error reading local backup file: ${err.message}`);
            sshProcess.kill(); // Attempt to kill SSH if input fails
            reject(new Error(`Error reading local backup file: ${err.message}`));
          });
        });

        if (exitCode !== 0) {
          throw new Error(`SSH mongorestore execution finished with exit code ${exitCode}. Stderr: ${errorOutput}`);
        }
        console.log('SSH restore process completed successfully.');
        this.processRestoreOutput(output, errorOutput);
      } else {
        // --- Direct Execution ---
        // ---> Аргументы baseArgs уже содержат --archive=path <---
        const directArgs = [...baseArgs];

        console.log('\nExecuting local mongorestore command:');
        // Убедимся, что аргументы в кавычках не экранируются дополнительно оболочкой
        const commandString = `${mongorestorePath} ${directArgs.map((arg) => (arg.includes(' ') ? `"${arg}"` : arg)).join(' ')}`;
        console.log(`${commandString}\n`);

        const restoreProcess = spawn(mongorestorePath, directArgs, {
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: false, // Важно: не использовать shell, чтобы избежать проблем с кавычками
        });

        let output = '';
        restoreProcess.stdout.on('data', (data) => {
          const chunk = data.toString();
          console.log(`mongorestore: ${chunk.trim()}`);
          output += chunk;
        });

        let errorOutput = '';
        restoreProcess.stderr.on('data', (data) => {
          const errorChunk = data.toString();
          console.warn(`mongorestore stderr: ${errorChunk.trim()}`);
          errorOutput += errorChunk;
        });

        const exitCode = await new Promise<number>((resolve, reject) => {
          restoreProcess.on('close', resolve);
          restoreProcess.on('error', (err) => {
            console.error(`Failed to start local mongorestore process: ${err.message}`);
            reject(new Error(`Failed to start local mongorestore process: ${err.message}`));
          });
        });

        if (exitCode !== 0) {
          throw new Error(`Local mongorestore finished with exit code ${exitCode}. Stderr: ${errorOutput}`);
        }
        console.log('Local restore process completed successfully.');
        this.processRestoreOutput(output, errorOutput);
      }
    } catch (error: any) {
      console.error(`\n✖ Error during restore: ${error.message}`);
      throw error; // Re-throw the error
    }
  }

  /**
   * Processes the stdout and stderr streams from mongorestore to provide categorized output.
   * Separates informational messages from potential errors within stderr.
   *
   * @param stdout - The accumulated standard output string.
   * @param stderr - The accumulated standard error string.
   */
  private processRestoreOutput(stdout: string, stderr: string): void {
    // Positive patterns indicating progress or success, often found in stderr
    const positivePatterns = [
      'document(s) restored successfully',
      'finished restoring',
      'preparing collections to restore',
      'reading metadata',
      'restoring',
      'done',
      'no indexes to restore',
      'index:',
      'restoring indexes',
      'options:', // Often precedes informational output
    ];

    console.log('\n--- mongorestore Execution Summary ---'); // Add a header for clarity

    if (stderr) {
      const errorLines = stderr.split('\n').filter((line) => line.trim());
      const [infoLines, realErrors] = this.splitOutputLines(errorLines, positivePatterns);

      if (infoLines.length > 0) {
        // Log informational messages from stderr clearly
        console.log('[mongorestore Info (from stderr)]:\n', infoLines.join('\n'));
      }
      if (realErrors.length > 0) {
        // Log potential errors from stderr with more emphasis
        console.warn('[mongorestore Potential Issues (from stderr)]:\n', realErrors.join('\n'));
      }
    } else {
      console.log('[mongorestore stderr]: (empty)');
    }

    if (stdout) {
      // Log standard output
      console.log('[mongorestore stdout]:\n', stdout.trim());
    } else {
      console.log('[mongorestore stdout]: (empty)');
    }
    console.log('------------------------------------'); // Footer for clarity
  }

  /**
   * Splits lines of output based on whether they contain known positive/informational patterns.
   *
   * @param lines - An array of output lines (typically from stderr).
   * @param patterns - An array of strings or regex patterns indicating informational messages.
   * @returns A tuple containing two arrays: [infoLines, realErrors].
   */
  private splitOutputLines(lines: string[], patterns: string[]): [string[], string[]] {
    const infoLines: string[] = [];
    const realErrors: string[] = [];

    for (const line of lines) {
      // Check if the line contains any of the positive patterns (case-insensitive)
      if (patterns.some((pattern) => line.toLowerCase().includes(pattern.toLowerCase()))) {
        infoLines.push(line);
      } else {
        realErrors.push(line);
      }
    }

    return [infoLines, realErrors];
  }

  private async checkRestoreResults(target: ConnectionConfig): Promise<void> {
    const mongoService = new MongoDBService(this.config);
    try {
      await mongoService.connect(target);
      const collections = await mongoService.getCollections(target.database);
      console.log(`Found ${collections.length} collections in the database ${target.database}`);
      if (collections.length > 0) {
        console.log(`Collections: ${collections.join(', ')}`);
      }
    } finally {
      await mongoService.close();
    }
  }
}
