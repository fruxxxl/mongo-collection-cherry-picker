import type { AppConfig, BackupMetadata, ConnectionConfig, RestoreOptions } from '../types/index';

import * as fs from 'fs';
import * as path from 'path';

import { spawn } from 'child_process';
import os from 'os';
import { Logger } from '../utils/logger';

/**
 * Handles the restoration of MongoDB backups using mongorestore.
 * Supports restoring from archives (.gz) via direct connection or SSH tunnel.
 */
export class RestoreService {
  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  /**
   * Restores a MongoDB database from a backup archive, using metadata for filtering.
   * Determines whether to run mongorestore locally or remotely via SSH based on the target configuration.
   * Applies namespace filtering (--nsInclude/--nsExclude) based on the backup metadata.
   *
   * @param backupMetadata - Metadata associated with the backup archive, including filtering intent.
   * @param target - The configuration of the target MongoDB connection for restoration.
   * @param options - Restoration options, such as dropping collections (`drop`).
   * @returns A promise that resolves when the restoration is complete.
   * @throws An error if the restoration process fails or prerequisites are not met.
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
    console.log(`Target connection: ${target.name} (Database: ${target.database})`);
    if (options.drop) {
      console.log('Option --drop enabled: Existing collections in the target database will be dropped.');
    }

    const baseArgs: string[] = [];

    // --- Target Connection Arguments ---
    if (target.uri && !target.ssh) {
      baseArgs.push(`--uri="${target.uri}"`);
    } else if (!target.ssh) {
      if (target.host) baseArgs.push(`--host=${target.host}`);
      if (target.port) baseArgs.push(`--port=${target.port}`);
      if (target.username) baseArgs.push(`--username=${target.username}`);
      if (target.password) baseArgs.push(`--password=${target.password}`);
      const authDb = target.authenticationDatabase || target.authSource || target.authDatabase;
      if (authDb) baseArgs.push(`--authenticationDatabase=${authDb}`);
    }
    // --- End Target Connection Arguments ---

    // --- Namespace Mapping ---
    const sourceDbInBackup = backupMetadata.database;
    if (!sourceDbInBackup) {
      console.warn(
        `Warning: Source database name not found in backup metadata for ${backupMetadata.archivePath}. Restore might behave unexpectedly if collections weren't in the default 'test' db.`,
      );
      if (target.database) {
        baseArgs.push(`--db=${target.database}`);
      } else if (!target.uri) {
        throw new Error(
          `[${target.name}] Target database name is required for restore if URI is not provided and source DB is unknown in metadata.`,
        );
      }
    } else if (target.database) {
      baseArgs.push(`--nsFrom="${sourceDbInBackup}.*"`);
      baseArgs.push(`--nsTo="${target.database}.*"`);
      console.log(`Mapping namespaces from "${sourceDbInBackup}" to "${target.database}"`);
    } else if (!target.uri) {
      throw new Error(`[${target.name}] Target database name is required for restore if URI is not provided.`);
    }
    // --- End Namespace Mapping ---

    // Add the --drop option if specified
    if (options.drop) {
      baseArgs.push('--drop');
    }

    // Specify the input archive file
    baseArgs.push(`--archive=${archivePath}`);
    baseArgs.push('--gzip');

    try {
      const mongorestorePath = this.config.mongorestorePath || 'mongorestore';
      let commandStringForLog = '';

      // --- Execute mongorestore (Local or SSH) ---
      if (target.ssh) {
        // --- SSH Execution ---
        console.log(`Executing mongorestore via SSH to ${target.ssh.host}...`);
        const remoteArgs = [...baseArgs];
        const archiveIndex = remoteArgs.findIndex((arg) => arg.startsWith('--archive='));
        if (archiveIndex > -1) {
          remoteArgs.splice(archiveIndex, 1);
          remoteArgs.push('--archive');
        } else {
          remoteArgs.push('--archive');
        }

        if (target.uri) {
          if (!remoteArgs.some((arg) => arg.startsWith('--uri='))) {
            remoteArgs.push(`--uri="${target.uri}"`);
          }
        } else if (!remoteArgs.some((arg) => arg.startsWith('--host=') || arg.startsWith('--port='))) {
          console.warn(
            `[${target.name}] Warning: SSH restore without URI might need host/port if remote mongorestore isn't connecting to localhost.`,
          );
        }

        const remoteCommand = `${mongorestorePath} ${remoteArgs.join(' ')}`;
        commandStringForLog = `cat ${archivePath} | ssh ... "${remoteCommand}"`;
        console.log(`Remote command to execute: ${remoteCommand}`);
        console.log(`Piping local archive: ${archivePath}`);

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

        const sshProcess = spawn('ssh', sshArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
        const archiveStream = fs.createReadStream(archivePath);
        archiveStream.pipe(sshProcess.stdin);

        archiveStream.on('error', (err) => {
          console.error(`Error reading local archive file ${archivePath}: ${err.message}`);
          if (!sshProcess.killed) sshProcess.kill();
        });

        let output = '';
        sshProcess.stdout.on('data', (data) => {
          const chunk = data.toString();
          console.log(`mongorestore (ssh): ${chunk.trim()}`);
          output += chunk;
        });
        let errorOutput = '';
        sshProcess.stderr.on('data', (data) => {
          const errorChunk = data.toString();
          console.warn(`mongorestore (ssh): ${errorChunk.trim()}`);
          errorOutput += errorChunk;
        });

        const exitCode = await new Promise<number>((resolve, reject) => {
          sshProcess.on('close', resolve);
          sshProcess.on('error', (err) => {
            console.error(`Failed to start SSH process: ${err.message}`);
            reject(new Error(`Failed to start SSH process: ${err.message}`));
          });
          archiveStream.on('close', () => {
            console.log(`Finished piping ${archivePath} to SSH stdin.`);
          });
          archiveStream.on('error', (err) => {
            if (!sshProcess.killed) sshProcess.kill();
            reject(new Error(`Failed reading archive for SSH pipe: ${err.message}`));
          });
        });

        if (exitCode !== 0) {
          throw new Error(`SSH mongorestore execution finished with exit code ${exitCode}. Stderr: ${errorOutput}`);
        }
        console.log('SSH restore process completed successfully.');
        this.processRestoreOutput(output, errorOutput);
      } else {
        // --- Direct Local Execution ---
        const directArgs = [...baseArgs];
        commandStringForLog = `${mongorestorePath} ${directArgs.map((arg) => (arg.includes(' ') ? `"${arg}"` : arg)).join(' ')}`;
        console.log('\nExecuting local mongorestore command:');
        console.log(`${commandStringForLog}\n`);

        const restoreProcess = spawn(mongorestorePath, directArgs, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });

        let output = '';
        restoreProcess.stdout.on('data', (data) => {
          const chunk = data.toString();
          console.log(`mongorestore: ${chunk.trim()}`);
          output += chunk;
        });
        let errorOutput = '';
        restoreProcess.stderr.on('data', (data) => {
          const errorChunk = data.toString();
          console.warn(`mongorestore: ${errorChunk.trim()}`);
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
      // --- End Execute mongorestore ---
    } catch (error: any) {
      console.error(`\n✖ Error during restore: ${error.message}`);
      throw error;
    }
  }

  /**
   * Parses the output of mongorestore to extract summary information.
   * Logs the number of documents restored and failed.
   * Checks both stdout and stderr as mongorestore output can vary.
   *
   * @param stdout - The standard output string from the mongorestore process.
   * @param stderr - The standard error string from the mongorestore process.
   */
  private processRestoreOutput(stdout: string, stderr: string): void {
    const combinedOutput = stdout + '\n' + stderr;
    const successRegex = /(\d+)\s+document\(s\)\s+restored successfully/g;
    const failedRegex = /(\d+)\s+document\(s\)\s+failed to restore/g;
    let totalRestored = 0;
    let totalFailed = 0;
    let match;
    while ((match = successRegex.exec(combinedOutput)) !== null) {
      totalRestored += parseInt(match[1], 10);
    }
    while ((match = failedRegex.exec(combinedOutput)) !== null) {
      totalFailed += parseInt(match[1], 10);
    }
    if (totalRestored === 0 && totalFailed === 0 && !stderr.match(/fail|error/i)) {
      const simpleCountMatch = stdout.match(/(\d+)\s+documents/);
      if (simpleCountMatch) {
        console.log(
          'Restore output doesn`t explicitly state success/failure counts, but no errors detected in stderr.',
        );
      } else if (!stderr.trim()) {
        console.log('Restore process finished without explicit counts, and stderr is empty.');
      }
    }
    console.log('\n--- Restore Summary ---');
    console.log(`Documents restored: ${totalRestored}`);
    if (totalFailed > 0) console.warn(`Documents failed:   ${totalFailed}`);
    else console.log(`Documents failed:   ${totalFailed}`);
    console.log('---------------------\n');
  }
}
