import ora from 'ora';
import path from 'path';
import inquirer from 'inquirer';
import fs from 'fs';
import { MongoDBService } from '../services/mongodb.service';
import { BackupService } from '../services/backup.service';
import { RestoreService } from '../services/restore.service';
import { PromptService } from '../utils/prompts';
import { AppConfig, RestorePreset, ConnectionConfig } from '../types/index';

export class RestoreManager {
  private config: AppConfig;
  private mongoService: MongoDBService;
  private backupService: BackupService;
  private restoreService: RestoreService;
  private promptService: PromptService;

  constructor(config: AppConfig) {
    this.config = config;
    this.mongoService = new MongoDBService(config);
    this.backupService = new BackupService(config);
    this.restoreService = new RestoreService(config);
    this.promptService = new PromptService(config);
  }

  async runRestore(
    backupFile: string,
    targetName: string,
    collections: string[] = []
  ): Promise<void> {
    if (!fs.existsSync(backupFile)) {
      throw new Error(`Backup file not found: ${backupFile}`);
    }

    const backupMetadata = this.backupService.loadBackupMetadata(backupFile);

    // Find target connection
    const targetConfig = this.config.connections.find(
      (conn: ConnectionConfig) => conn.name === targetName
    );
    if (!targetConfig) {
      throw new Error(`Connection "${targetName}" not found in configuration`);
    }

    // If collections are not specified, use all from backup
    const collectionsToRestore = collections.length > 0 ? collections : backupMetadata.collections;

    // Restoration
    await this.restoreService.restoreBackup(backupMetadata, targetConfig, collectionsToRestore);

    console.log(`Backup successfully restored to database ${targetName}`);
  }

  async restoreDatabase(): Promise<void> {
    // Use PromptService for interactive selection
    const { backupFile, target } = await this.promptService.promptForRestore();

    // Load metadata from file
    const backupMetadata = this.backupService.loadBackupMetadata(backupFile);

    // Restore backup
    await this.restoreService.restoreBackup(backupMetadata, target);
  }

  async useRestorePreset(preset: RestorePreset): Promise<void> {
    const target = this.config.connections.find(
      (conn: ConnectionConfig) => conn.name === preset.targetName
    );

    if (!target) {
      throw new Error(`Target "${preset.targetName}" not found in configuration`);
    }

    // Get list of backup files matching pattern
    const backupFiles = this.backupService.getBackupFiles();

    let filteredFiles = backupFiles;
    if (preset.backupPattern) {
      const pattern = new RegExp(preset.backupPattern.replace('*', '.*'));
      filteredFiles = backupFiles.filter((file: string) => pattern.test(file));
    }

    if (filteredFiles.length === 0) {
      throw new Error('No backup files found matching pattern');
    }

    // Select backup file
    const { backupFile } = await inquirer.prompt({
      type: 'list',
      name: 'backupFile',
      message: 'Select backup file for restoration:',
      choices: filteredFiles
    });

    // Load backup metadata
    const backupMetadata = this.backupService.loadBackupMetadata(backupFile);

    // Prepare command
    const commandArgs = [
      `--host=${target.host || 'localhost'}:${target.port || 27017}`,
      `--db=${target.database}`,
      `--gzip`,
      `--archive=${path.join(this.config.backupDir, backupFile)}`,
      `--drop`
    ];

    console.log('\nCommand to be executed:');
    console.log(`mongorestore ${commandArgs.join(' ')}\n`);

    const { confirm } = await inquirer.prompt({
      type: 'confirm',
      name: 'confirm',
      message: 'Confirm command execution:',
      default: true
    });

    if (confirm) {
      // Execute restoration
      const spinner = ora('Restoring backup...').start();
      try {
        await this.restoreService.restoreBackup(backupMetadata, target);
        spinner.succeed(`Backup successfully restored to database ${target.database}`);
      } catch (error) {
        spinner.fail(
          `Error restoring backup: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }
}
