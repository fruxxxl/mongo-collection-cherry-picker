import ora from 'ora';
import path from 'path';
import inquirer from 'inquirer';
import fs from 'fs';
import { BackupService } from '../services/backup.service';
import { RestoreService } from '../services/restore.service';
import type { PromptService } from '../services/prompt-service';
import type { AppConfig, RestorePreset, ConnectionConfig, BackupMetadata } from '../types/index';
import { Logger } from '../utils/logger';

/**
 * Manages the restore process, coordinating user prompts (if needed) and the RestoreService.
 */
export class RestoreController {
  constructor(
    private readonly config: AppConfig,
    private readonly backupService: BackupService,
    private readonly promptService: PromptService,
    private readonly restoreService: RestoreService,
    private readonly logger: Logger,
  ) {}

  /**
   * Runs the restore operation for a given backup file to a specified target connection.
   * Loads backup metadata and calls the RestoreService, passing the metadata for filtering.
   *
   * @param backupFilename - The filename (relative to backupDir) of the backup archive to restore.
   * @param targetName - The name of the target connection configuration.
   * @param options - Restoration options (e.g., { drop: true }).
   * @throws An error if the target connection or backup file is not found, or if metadata loading/restore fails.
   */
  async runRestore(backupFilename: string, targetName: string, options: { drop: boolean }): Promise<void> {
    this.logger.startSpinner(`Preparing restore for ${backupFilename} to ${targetName}...`);
    try {
      const targetConfig = this.config.connections.find((c) => c.name === targetName);
      if (!targetConfig) {
        throw new Error(`Target connection "${targetName}" not found in configuration.`);
      }
      if (!targetConfig.database) {
        throw new Error(`Target connection "${targetName}" must have a 'database' field defined for restore.`);
      }

      this.logger.updateSpinner(`Loading metadata for ${backupFilename}...`);
      let backupMetadata: BackupMetadata;
      try {
        backupMetadata = this.backupService.loadBackupMetadata(backupFilename);
        this.logger.info(`Loaded metadata for ${backupFilename}. Source DB: ${backupMetadata.database || 'N/A'}`);
        this.logger.logRaw('--- Backup Metadata ---');
        this.logger.logRaw(`Source:   ${backupMetadata.source}`);
        this.logger.logRaw(`Database: ${backupMetadata.database || 'N/A'}`);
        this.logger.logRaw(`Created:  ${new Date(backupMetadata.timestamp).toLocaleString()}`);
        this.logger.logRaw(`Mode:     ${backupMetadata.selectionMode}`);
        if (backupMetadata.includedCollections?.length) {
          this.logger.logRaw(`Included: ${backupMetadata.includedCollections.join(', ')}`);
        }
        if (backupMetadata.excludedCollections?.length) {
          this.logger.logRaw(`Excluded: ${backupMetadata.excludedCollections.join(', ')}`);
        }
        this.logger.logRaw('-----------------------\n');
      } catch (error: any) {
        throw new Error(`Failed to load metadata for backup "${backupFilename}": ${error.message}`);
      }

      const backupDir = path.resolve(this.config.backupDir);
      const fullBackupPath = path.join(backupDir, backupMetadata.archivePath);
      if (!fs.existsSync(fullBackupPath)) {
        throw new Error(
          `Backup archive file "${backupMetadata.archivePath}" specified in metadata not found in directory "${backupDir}".`,
        );
      }

      this.logger.stopSpinner();
      this.logger.info(`Initiating restore process for ${backupFilename} to ${targetName}...`);

      await this.restoreService.restoreBackup(backupMetadata, targetConfig, options);

      this.logger.succeedSpinner(
        `Backup "${backupFilename}" successfully restored to target "${targetName}" (Database: ${targetConfig.database})`,
      );
    } catch (error: any) {
      if (this.logger.spinner?.isSpinning) {
        this.logger.failSpinner(`Restore operation failed: ${error.message}`);
      } else {
        this.logger.error(`\n✖ Restore operation failed: ${error.message}`);
      }
      if (this.logger.spinner?.isSpinning) {
        this.logger.stopSpinner();
      }
    }
  }

  /**
   * Initiates the interactive restore process.
   * Prompts the user for backup file and target, then calls runRestore.
   */
  async restoreDatabase(): Promise<void> {
    this.logger.startSpinner('Starting interactive restore...');
    try {
      this.logger.stopSpinner();
      const { backupFile, target, options } = await this.promptService.promptForRestore();
      this.logger.startSpinner(`Preparing restore for ${backupFile} to ${target.name}...`);

      await this.runRestore(backupFile, target.name, options);
    } catch (error: any) {
      this.logger.failSpinner(`Interactive restore failed: ${error.message}`);
    }
  }

  async useRestorePreset(preset: RestorePreset): Promise<void> {
    const target = this.config.connections.find((conn: ConnectionConfig) => conn.name === preset.targetName);

    if (!target) {
      throw new Error(`Target "${preset.targetName}" not found in configuration`);
    }

    const backupFiles = this.backupService.getBackupFiles();

    let filteredFiles = backupFiles;
    if (preset.backupPattern) {
      const pattern = new RegExp(preset.backupPattern.replace('*', '.*'));
      filteredFiles = backupFiles.filter((file: string) => pattern.test(file));
    }

    if (filteredFiles.length === 0) {
      throw new Error('No backup files found matching pattern');
    }

    const { backupFile } = await inquirer.prompt({
      type: 'list',
      name: 'backupFile',
      message: 'Select backup file for restoration:',
      choices: filteredFiles,
    });

    const backupMetadata = this.backupService.loadBackupMetadata(backupFile);

    const options = preset.options || {};

    const commandArgs = [
      `--host=${target.host || 'localhost'}:${target.port || 27017}`,
      `--db=${target.database}`,
      '--gzip',
      `--archive=${path.join(this.config.backupDir, backupFile)}`,
    ];

    if (options.drop) {
      commandArgs.push('--drop');
    }

    this.logger.info('\nCommand to be executed:');
    this.logger.info(`mongorestore ${commandArgs.join(' ')}\n`);

    const { confirm } = await inquirer.prompt({
      type: 'confirm',
      name: 'confirm',
      message: 'Confirm command execution:',
      default: true,
    });

    if (confirm) {
      this.logger.startSpinner('Restoring backup...');
      try {
        await this.restoreService.restoreBackup(backupMetadata, target, options);
        this.logger.succeedSpinner(`Backup successfully restored to database ${target.database}`);
      } catch (error) {
        this.logger.failSpinner(`Error restoring backup: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}
