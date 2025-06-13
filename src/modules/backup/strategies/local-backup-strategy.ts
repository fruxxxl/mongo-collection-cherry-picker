import { spawn } from 'child_process';

import type { AppConfig, ConnectionConfig } from '../../../types/types';
import type { BackupArgs } from '../interfaces/backup-args.interface';
import { BackupStrategy } from '../interfaces/backup-strategy.interface';
import { BackupCommand } from '../domain/backup-command';
import { Logger } from '../../../infrastructure/logger';

export class LocalBackupStrategy implements BackupStrategy {
  private readonly backupCommand: BackupCommand;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {
    this.backupCommand = new BackupCommand(this.config, this.logger);
  }

  async createBackup(source: ConnectionConfig, args: BackupArgs): Promise<string> {
    const { baseArgs } = this.backupCommand.buildMongodumpArgs(source, args);
    const filePath = this.backupCommand.buildBackupFilePath(source);

    baseArgs.push(`--archive=${filePath}`);

    // Log the final mongodump command
    const commandString = `mongodump ${baseArgs.map((arg) => (arg.includes(' ') ? `"${arg}"` : arg)).join(' ')}`;
    this.logger.info(`[${source.name}] Running mongodump command: 
      -------------------
      ${commandString}
      -------------------
      `);

    // Start the mongodump process with the given arguments.
    // stdio: ['pipe', 'pipe', 'pipe'] means:
    //   - stdin is a writable stream (can send query input to mongodump)
    //   - stdout is a readable stream (can read dump output or logs)
    //   - stderr is a readable stream (can read error messages and mongodump logs)
    const mongodumpProcess = spawn('mongodump', baseArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // No need to write to stdin anymore, query is always passed as argument

    return new Promise<string>((resolve, reject) => {
      let stdoutData = '';
      let stderrData = '';

      mongodumpProcess.stdout.on('data', (data) => {
        stdoutData += data.toString();
      });

      mongodumpProcess.stderr.on('data', (data) => {
        stderrData += data.toString();
        this.logger.warn(`[${source.name}] mongodump: ${data.toString().trim()}`);
      });

      mongodumpProcess.on('close', (code) => {
        if (code === 0) {
          this.logger.succeedSpinner(`Created backup for ${source.name}: ${filePath}`);
          resolve(filePath);
        } else {
          const error = new Error(
            `mongodump process exited with code ${code}. stderr: ${stderrData}\nstdout: ${stdoutData}`,
          );
          this.backupCommand.handleBackupError(error, source, filePath, `mongodump ${baseArgs.join(' ')}`);
        }
      });

      mongodumpProcess.on('error', (error) => {
        try {
          this.backupCommand.handleBackupError(error, source, filePath, `mongodump ${baseArgs.join(' ')}`);
        } catch (error) {
          reject(error);
        }
      });
    });
  }
}
