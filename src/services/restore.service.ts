import { AppConfig, BackupMetadata, ConnectionConfig, RestoreOptions } from '../types/index';
import ora from 'ora';
import { BackupService } from './backup.service';
import path from 'path';

export class RestoreService {
  private config: AppConfig;

  constructor(config: AppConfig) {
    this.config = config;
  }

  async restoreBackup(
    backupMetadata: BackupMetadata,
    target: ConnectionConfig,
    options: RestoreOptions
  ): Promise<boolean> {
    const spinner = ora('Restoring backup...').start();

    try {
      // Use BackupService directly for restoration
      const backupService = new BackupService(this.config);
      const archivePath = path.join(this.config.backupDir, backupMetadata.archivePath);

      console.log(`Restoring from file: ${archivePath}`);
      console.log(`Collections in backup: ${JSON.stringify(backupMetadata.collections)}`);

      const result = await backupService.restoreBackup(target, archivePath, options);

      if (!result) {
        throw new Error('Failed to restore backup');
      }

      spinner.succeed(`Backup restored in ${target.name} (${target.database})`);
      return true;
    } catch (error) {
      spinner.fail(
        `Error restoring backup: ${error instanceof Error ? error.message : String(error)}`
      );
      return false;
    }
  }
}
