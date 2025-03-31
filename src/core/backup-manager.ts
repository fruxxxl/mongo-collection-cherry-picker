import ora from 'ora';
import inquirer from 'inquirer';
import { MongoDBService } from '../services/mongodb.service';
import { BackupService } from '../services/backup.service';
import { RestoreService } from '../services/restore.service';
import { PromptService } from '../utils/prompts';
import { AppConfig, ConnectionConfig } from '../types/index';

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
    collectionsList: string[] = []
  ): Promise<string> {
    // Find connection by name
    const sourceConfig = this.config.connections.find(
      (conn: ConnectionConfig) => conn.name === sourceName
    );
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
      includedCollections = allCollections.filter(
        (col: string) => !excludedCollections.includes(col)
      );
    }

    // Create backup
    const backupPath = await this.backupService.createBackup(
      sourceConfig,
      includedCollections,
      excludedCollections
    );

    console.log(`Backup successfully created: ${backupPath}`);
    return backupPath;
  }

  async backupDatabase(): Promise<void> {
    // Use PromptService for interactive selection
    const { source, selectedCollections, excludedCollections } =
      await this.promptService.promptForBackup();

    // Connect to MongoDB and get collection list
    const spinner = ora('Connecting to database...').start();

    try {
      await this.mongoService.connect(source);
      spinner.succeed('Connection successfully established');

      spinner.start('Getting collection list...');
      const collections = await this.mongoService.getCollections(source.database);
      spinner.succeed(`Got ${collections.length} collections`);

      await this.mongoService.close();

      // Create backup
      spinner.start('Creating backup...');
      const backupPath = await this.backupService.createBackup(
        source,
        selectedCollections,
        excludedCollections
      );
      spinner.succeed(`Backup successfully created: ${backupPath}`);

      // Suggest to restore backup to another database
      const { restore } = await inquirer.prompt({
        type: 'confirm',
        name: 'restore',
        message: 'Do you want to restore backup to another database?',
        default: false
      });

      if (restore) {
        const backupMetadata = this.backupService.loadBackupMetadata(backupPath);
        const { target, options } = await this.promptService.promptForRestoreTarget(
          backupMetadata,
          source
        );
        const restoreService = new RestoreService(this.config);

        await restoreService.restoreBackup(backupMetadata, target, options);
      } else {
        console.log('Work completed. Have a good day!');
        process.exit(0);
      }
    } catch (error) {
      spinner.fail(`Error: ${error instanceof Error ? error.message : String(error)}`);
      await this.mongoService.close();
    }
  }

  async useBackupPreset(preset: any): Promise<void> {
    const source = this.config.connections.find(
      (conn: ConnectionConfig) => conn.name === preset.sourceName
    );

    if (!source) {
      throw new Error(`Source "${preset.sourceName}" not found in configuration`);
    }

    // Create arrays of selected/excluded collections based on preset
    let selectedCollections: string[] = [];
    let excludedCollections: string[] = [];

    if (preset.selectionMode === 'all') {
      // All collections
      await this.mongoService.connect(source);
      selectedCollections = await this.mongoService.getCollections(source.database);
      await this.mongoService.close();
    } else if (preset.selectionMode === 'include') {
      // Only specified collections
      selectedCollections = preset.collections || [];
    } else {
      // Exclude specified collections
      excludedCollections = preset.collections || [];

      // Get all collections to exclude specified ones
      await this.mongoService.connect(source);
      const allCollections = await this.mongoService.getCollections(source.database);
      await this.mongoService.close();

      selectedCollections = allCollections.filter(
        (coll: string) => !excludedCollections.includes(coll)
      );
    }

    // Check command before execution
    const commandArgs = [
      `--host=${source.host || 'localhost'}:${source.port || 27017}`,
      `--db=${source.database}`,
      `--gzip`,
      `--archive=./backups/backup_example.gz`
    ];

    if (preset.selectionMode === 'exclude') {
      excludedCollections.forEach((coll: string) => {
        commandArgs.push(`--excludeCollection=${coll}`);
      });
    } else if (preset.selectionMode === 'include') {
      selectedCollections.forEach((coll: string) => {
        commandArgs.push(`--collection=${coll}`);
      });
    }

    console.log('\nExecuting mongodump command:');
    console.log(`mongodump ${commandArgs.join(' ')}\n`);

    const { confirm } = await inquirer.prompt({
      type: 'confirm',
      name: 'confirm',
      message: 'Confirm command execution:',
      default: true
    });

    if (confirm) {
      // Run backup
      const spinner = ora('Creating backup...').start();
      try {
        spinner.text = 'Running mongodump...';
        const backupPath = await this.backupService.createBackup(
          source,
          selectedCollections,
          excludedCollections
        );
        spinner.succeed(`Backup successfully created: ${backupPath}`);
      } catch (error) {
        spinner.fail(
          `Error creating backup: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }
}
