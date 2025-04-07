import ora from 'ora';

import { MongoDBService } from '../services/mongodb.service';
import { BackupService } from '../services/backup.service';

import { PromptService } from '../utils/prompts';
import { AppConfig, ConnectionConfig, BackupPreset } from '../types/index';

export class BackupManager {
  private config: AppConfig;
  private mongoService: MongoDBService;
  private backupService: BackupService;
  private promptService: PromptService;

  constructor(config: AppConfig) {
    this.config = config;
    this.mongoService = new MongoDBService(config);
    this.backupService = new BackupService(config);
    this.promptService = new PromptService(config);
  }

  async runBackup(
    sourceName: string,
    mode: 'all' | 'include' | 'exclude',
    collectionsList: string[] = [],
  ): Promise<string> {
    // Find connection by name
    const sourceConfig = this.config.connections.find((conn: ConnectionConfig) => conn.name === sourceName);
    if (!sourceConfig) {
      throw new Error(`Connection "${sourceName}" not found in configuration`);
    }

    // Connect to MongoDB
    await this.mongoService.connect(sourceConfig);
    console.log(`Connection successfully established to ${sourceName}`);

    // Get collection list
    const allCollections = await this.mongoService.getCollections(sourceConfig.database);
    await this.mongoService.close();

    // Define collections for backup
    let includedCollections: string[] = [];
    let excludedCollections: string[] = [];

    if (mode === 'all') {
      includedCollections = allCollections;
    } else if (mode === 'include') {
      includedCollections = collectionsList;
    } else if (mode === 'exclude') {
      excludedCollections = collectionsList;
      includedCollections = allCollections.filter((col: string) => !excludedCollections.includes(col));
    }

    // Create backup
    const backupPath = await this.backupService.createBackup(
      sourceConfig,
      includedCollections,
      excludedCollections,
      mode,
    );

    console.log(`Backup successfully created: ${backupPath}`);
    return backupPath;
  }

  async backupDatabase(
    sourceName?: string,
    mode?: 'all' | 'include' | 'exclude',
    collections?: string[],
  ): Promise<void> {
    let sourceConfig: ConnectionConfig;
    let includedCollections: string[] = [];
    let excludedCollections: string[] = [];
    let selectionMode: 'all' | 'include' | 'exclude';

    if (sourceName && mode) {
      // Non-interactive mode
      sourceConfig = this.config.connections.find((conn) => conn.name === sourceName)!;
      if (!sourceConfig) {
        throw new Error(`Source connection "${sourceName}" not found in config.`);
      }
      selectionMode = mode;
      if (mode === 'include') {
        includedCollections = collections || [];
      } else if (mode === 'exclude') {
        excludedCollections = collections || [];
      }
    } else {
      // Interactive mode
      const backupDetails = await this.promptService.promptForBackup();
      sourceConfig = backupDetails.source;
      includedCollections = backupDetails.selectedCollections;
      excludedCollections = backupDetails.excludedCollections;
      selectionMode = backupDetails.selectionMode;
    }

    const spinner = ora('Creating backup...').start();
    try {
      const backupPath = await this.backupService.createBackup(
        sourceConfig,
        includedCollections,
        excludedCollections,
        selectionMode,
      );
      spinner.succeed(`Backup created successfully: ${backupPath}`);
    } catch (error: any) {
      spinner.fail(`Error creating backup: ${error.message}`);
    }
  }

  async listBackups(): Promise<void> {
    // ... код без изменений ...
  }

  async manageBackupPresets(): Promise<void> {
    const selectedPresetAction = await this.promptService.managePresets();

    if (selectedPresetAction && selectedPresetAction.type === 'backup') {
      const preset = selectedPresetAction.preset as BackupPreset;
      console.log(`\nUsing backup preset: ${preset.name}`);
      await this.useBackupPreset(preset);
    }
  }

  async useBackupPreset(preset: BackupPreset): Promise<void> {
    const source = this.config.connections.find((conn) => conn.name === preset.sourceName);
    if (!source) {
      throw new Error(`Source connection "${preset.sourceName}" not found for preset "${preset.name}".`);
    }

    let selectedCollections: string[] = [];
    let excludedCollections: string[] = [];

    if (preset.selectionMode === 'include') {
      selectedCollections = preset.collections || [];
    } else if (preset.selectionMode === 'exclude') {
      excludedCollections = preset.collections || [];
    }

    const spinner = ora(`Creating backup using preset "${preset.name}"...`).start();
    try {
      const backupPath = await this.backupService.createBackup(
        source,
        selectedCollections,
        excludedCollections,
        preset.selectionMode,
      );
      spinner.succeed(`Backup created successfully using preset "${preset.name}": ${backupPath}`);
    } catch (error: any) {
      spinner.fail(`Error creating backup with preset "${preset.name}": ${error.message}`);
    }
  }

  async createBackupPreset(): Promise<void> {
    // ... код без изменений ...
  }
}
