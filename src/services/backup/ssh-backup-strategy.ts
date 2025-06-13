import * as fs from 'fs';
import type { AppConfig, ConnectionConfig } from '../../types';
import { Logger } from '../../utils/logger';
import type { BackupStrategy, BackupArgs } from './backup-strategy';
import { SshService } from './ssh-service';
import { BackupCommand } from './backup-command';

export class SshBackupStrategy implements BackupStrategy {
  private readonly backupCommand: BackupCommand;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly sshService: SshService,
  ) {
    this.backupCommand = new BackupCommand(this.config, this.logger);
  }

  async createBackup(source: ConnectionConfig, args: BackupArgs): Promise<string> {
    if (!source.ssh) {
      throw new Error(`[${source.name}] SSH configuration is required for SSH backup strategy.`);
    }

    const { baseArgs, queryValue } = this.backupCommand.buildMongodumpArgs(source, args);
    const filePath = this.backupCommand.buildBackupFilePath(source);
    this.backupCommand.ensureBackupDir();

    const tempFilePath = `${filePath}.tmp`;
    baseArgs.push('--archive');

    try {
      await this.sshService.executeCommand(source.ssh, 'mongodump', baseArgs, queryValue, tempFilePath);

      // Rename temp file to final name
      fs.renameSync(tempFilePath, filePath);
      this.logger.succeedSpinner(`Created backup for ${source.name}: ${filePath}`);

      return filePath;
    } catch (error: any) {
      this.backupCommand.handleBackupError(error, source, tempFilePath, `mongodump ${baseArgs.join(' ')}`);
    }
  }
}
