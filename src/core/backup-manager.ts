import ora from 'ora';
import path from 'path'; // Needed for metadata path
import fs from 'fs'; // Needed for saving metadata

import { MongoDBService } from '../services/mongodb.service';
import { BackupService } from '../services/backup.service';

import { PromptService } from '../utils/prompts';
import { AppConfig, BackupPreset, BackupMetadata } from '../types/index';

/**
 * Manages the backup process, coordinating user prompts, backup service, and metadata generation.
 */
export class BackupManager {
  private config: AppConfig;
  private mongoService: MongoDBService;
  private backupService: BackupService;
  private promptService: PromptService;

  /**
   * Creates an instance of BackupManager.
   * @param config - The application configuration.
   * @param promptService - Service for handling user interactions.
   */
  constructor(config: AppConfig, promptService: PromptService) {
    this.config = config;
    this.mongoService = new MongoDBService(config);
    this.promptService = promptService;
    this.backupService = new BackupService(config);
  }

  /**
   * Initiates the interactive backup process.
   * Prompts the user for source, mode, and collections, then performs the backup.
   */
  async backupDatabase(): Promise<void> {
    const spinner = ora('Starting interactive backup...').start();
    try {
      // 1. Stop spinner before prompts
      spinner.stop(); // <-- Остановить спиннер перед вызовом promptForBackup

      // Get user intent from prompts
      const {
        source,
        selectedCollections,
        excludedCollections,
        selectionMode: intendedMode,
      } = await this.promptService.promptForBackup(); // <-- Вызвать промпты без активного спиннера

      // Restart spinner after prompts are done
      spinner.start(`Preparing backup for ${source.name}...`); // <-- Перезапустить спиннер

      let actualMode = intendedMode;
      let actualSelected: string[] = []; // Collections for --collection flag (usually empty now)
      let actualExcluded: string[] = []; // Collections for --excludeCollection flag

      // 2. Transform 'include' intent to 'exclude' command
      if (intendedMode === 'include') {
        // Stop spinner again if we need to fetch collections (handled inside promptForBackup now)
        // spinner.stop(); // Not needed here anymore as promptForBackup handles its own spinner for fetching
        // spinner.start(`Fetching all collections from ${source.name} to calculate exclusions...`); // Moved inside promptForBackup

        // Fetching logic is now inside promptForBackup, just need the results
        // Need to adjust logic here if promptForBackup doesn't fetch anymore
        // Assuming promptForBackup still returns the necessary data based on its internal logic

        // Re-calculate exclusions based on prompt results (if needed, or trust promptService)
        // This calculation might be redundant if promptService handles it, BUT
        // the transformation logic to 'exclude' mode MUST happen here in the manager.

        spinner.text = `Fetching all collections from ${source.name} to calculate exclusions...`; // Keep spinner text update
        // Ensure mongoService is available or handle connection within this method if needed
        await this.mongoService.connect(source); // Connect here before calculating exclusions
        const allCollections = await this.mongoService.getCollections(source.database);
        await this.mongoService.close(); // Close after getting collections
        spinner.text = `Calculating exclusions for ${source.name}...`;

        actualExcluded = allCollections.filter((coll) => !selectedCollections.includes(coll));
        actualMode = 'exclude'; // Set the mode for mongodump command
        actualSelected = []; // Clear selected, as we use exclude mode

        if (actualExcluded.length === allCollections.length && selectedCollections.length > 0) {
          console.warn(
            `\nWarning: None of the selected collections (${selectedCollections.join(', ')}) were found in the database ${source.database}. The backup might be empty if other collections exist.`,
          );
        } else if (actualExcluded.length === 0 && allCollections.length > 0) {
          console.log(
            `\nInfo: All collections in ${source.database} were selected for inclusion. Switching to 'all' mode for backup efficiency.`,
          );
          actualMode = 'all';
        } else {
          console.log(`\nInfo: Will exclude collections: ${actualExcluded.join(', ')}`);
        }
      } else if (intendedMode === 'exclude') {
        actualExcluded = excludedCollections; // Use directly from prompt
        actualMode = 'exclude';
        actualSelected = [];
      } else {
        // 'all' mode
        actualMode = 'all';
        actualSelected = [];
        actualExcluded = [];
      }

      spinner.text = `Running backup process for ${source.name}...`; // Update spinner text before calling backup service
      // 3. Call BackupService with transformed parameters
      const backupFilename = await this.backupService.createBackup(
        source,
        actualSelected, // Should be empty if actualMode is 'exclude' or 'all'
        actualExcluded, // Contains calculated exclusions or user-provided exclusions
        actualMode, // Will be 'all' or 'exclude'
      );

      spinner.text = `Saving metadata for ${backupFilename}...`;
      // 4. Save metadata using the *original* user intent
      const now = new Date();
      const metadata: BackupMetadata = {
        source: source.name,
        database: source.database,
        selectionMode: intendedMode, // Use the original mode selected by user
        includedCollections: intendedMode === 'include' ? selectedCollections : undefined,
        excludedCollections: intendedMode === 'exclude' ? excludedCollections : undefined,
        timestamp: now.getTime(),
        date: now.toISOString(),
        archivePath: path.basename(backupFilename),
      };
      const metadataPath = `${backupFilename}.json`;
      fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));

      spinner.succeed(`Backup created successfully: ${backupFilename}\nMetadata saved: ${metadataPath}`);
    } catch (error: any) {
      // Ensure spinner stops on error
      if (spinner.isSpinning) {
        spinner.fail(`Interactive backup failed: ${error.message}`);
      } else {
        // If spinner was already stopped (e.g., error during prompts), just log
        console.error(`Interactive backup failed: ${error.message}`);
      }
      // Log the error details if helpful
      // console.error(error);
    } finally {
      // Ensure connection is closed if it was opened in this method's scope
      if (this.mongoService.getClient()) {
        await this.mongoService.close();
      }
      // Ensure spinner is stopped if it's still running somehow
      if (spinner.isSpinning) {
        spinner.stop();
      }
    }
  }

  async manageBackupPresets(): Promise<void> {
    const selectedPresetAction = await this.promptService.managePresets();

    if (selectedPresetAction && selectedPresetAction.type === 'backup') {
      const preset = selectedPresetAction.preset as BackupPreset;
      console.log(`\nUsing backup preset: ${preset.name}`);
      await this.useBackupPreset(preset);
    }
  }

  /**
   * Creates a backup using a predefined preset configuration.
   * @param preset - The backup preset to use.
   */
  async useBackupPreset(preset: BackupPreset): Promise<void> {
    const spinner = ora(`Starting backup using preset: ${preset.name}...`).start();
    try {
      const source = this.config.connections.find((c) => c.name === preset.sourceName);
      if (!source) {
        throw new Error(`Source connection "${preset.sourceName}" defined in preset "${preset.name}" not found.`);
      }
      if (!source.database) {
        // Database name is crucial for fetching all collections if needed
        throw new Error(
          `Source connection "${preset.sourceName}" must have a 'database' field defined for preset usage.`,
        );
      }

      spinner.text = `Preparing backup for ${source.name} using preset ${preset.name}...`;

      const intendedMode = preset.selectionMode;
      const intendedCollections = preset.collections || []; // Collections defined in the preset

      let actualMode = intendedMode;
      let actualSelected: string[] = [];
      let actualExcluded: string[] = [];

      // Transform 'include' intent to 'exclude' command
      if (intendedMode === 'include') {
        spinner.text = `Fetching all collections from ${source.name} to calculate exclusions for preset ${preset.name}...`;
        await this.mongoService.connect(source);
        const allCollections = await this.mongoService.getCollections(source.database);
        await this.mongoService.close();
        spinner.text = `Calculating exclusions for preset ${preset.name}...`;

        actualExcluded = allCollections.filter((coll) => !intendedCollections.includes(coll));
        actualMode = 'exclude';
        actualSelected = [];

        if (actualExcluded.length === allCollections.length && intendedCollections.length > 0) {
          console.warn(
            `\nWarning: None of the collections specified in preset "${preset.name}" (${intendedCollections.join(', ')}) were found in the database ${source.database}. The backup might be empty if other collections exist.`,
          );
        } else if (actualExcluded.length === 0 && allCollections.length > 0) {
          console.log(
            `\nInfo: All collections in ${source.database} were selected by preset "${preset.name}". Switching to 'all' mode for backup efficiency.`,
          );
          actualMode = 'all';
        } else {
          console.log(`\nInfo: Preset "${preset.name}" will exclude collections: ${actualExcluded.join(', ')}`);
        }
      } else if (intendedMode === 'exclude') {
        actualExcluded = intendedCollections;
        actualMode = 'exclude';
        actualSelected = [];
      } else {
        // 'all' mode
        actualMode = 'all';
        actualSelected = [];
        actualExcluded = [];
      }

      spinner.text = `Running backup process for preset ${preset.name}...`;
      // Call BackupService with transformed parameters
      const backupFilename = await this.backupService.createBackup(source, actualSelected, actualExcluded, actualMode);

      spinner.text = `Saving metadata for preset backup ${backupFilename}...`;
      // Save metadata using the *preset's* intent
      const now = new Date();
      const metadata: BackupMetadata = {
        source: source.name,
        database: source.database,
        selectionMode: intendedMode, // Use preset's mode
        includedCollections: intendedMode === 'include' ? intendedCollections : undefined, // Use preset's collections
        excludedCollections: intendedMode === 'exclude' ? intendedCollections : undefined, // Use preset's collections
        timestamp: now.getTime(),
        date: now.toISOString(),
        archivePath: path.basename(backupFilename), // Store only the filename
        presetName: preset.name, // Optionally store the preset name used
      };
      const metadataPath = `${backupFilename}.json`;
      fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));

      spinner.succeed(
        `Backup from preset "${preset.name}" created successfully: ${backupFilename}\nMetadata saved: ${metadataPath}`,
      );
    } catch (error: any) {
      spinner.fail(`Backup from preset failed: ${error.message}`);
    } finally {
      // Ensure connection is closed if mongoService was used
      if (this.mongoService.getClient()) {
        await this.mongoService.close();
      }
    }
  }

  /**
   * Creates a backup based on provided arguments (e.g., from command line).
   * Handles the 'include' -> 'exclude' transformation and metadata saving.
   *
   * @param sourceName - The name of the source connection.
   * @param intendedMode - The desired backup mode ('all', 'include', 'exclude').
   * @param collectionsList - The list of collections for 'include' or 'exclude' mode.
   */
  async backupFromArgs(
    sourceName: string,
    intendedMode: 'all' | 'include' | 'exclude',
    collectionsList: string[] = [],
  ): Promise<void> {
    const spinner = ora(`Starting backup for ${sourceName} from arguments...`).start();
    try {
      // 1. Find source connection
      const source = this.config.connections.find((c) => c.name === sourceName);
      if (!source) {
        throw new Error(`Source connection "${sourceName}" not found in configuration.`);
      }
      if (!source.database) {
        throw new Error(`Source connection "${sourceName}" must have a 'database' field defined.`);
      }

      spinner.text = `Preparing backup for ${source.name}...`;

      let actualMode = intendedMode;
      let actualSelected: string[] = [];
      let actualExcluded: string[] = [];

      // 2. Transform 'include' intent to 'exclude' command
      if (intendedMode === 'include') {
        if (!collectionsList || collectionsList.length === 0) {
          throw new Error("Backup mode is 'include' but no collections were specified.");
        }
        spinner.text = `Fetching all collections from ${source.name} to calculate exclusions...`;
        await this.mongoService.connect(source);
        const allCollections = await this.mongoService.getCollections(source.database);
        await this.mongoService.close();
        spinner.text = `Calculating exclusions for ${source.name}...`;

        actualExcluded = allCollections.filter((coll) => !collectionsList.includes(coll));
        actualMode = 'exclude';
        actualSelected = [];

        if (actualExcluded.length === allCollections.length) {
          console.warn(
            `\nWarning: None of the specified collections (${collectionsList.join(', ')}) were found in the database ${source.database}. The backup might be empty if other collections exist.`,
          );
        } else if (actualExcluded.length === 0 && allCollections.length > 0) {
          console.log(
            `\nInfo: All collections in ${source.database} were specified for inclusion. Switching to 'all' mode for backup efficiency.`,
          );
          actualMode = 'all';
        } else {
          console.log(`\nInfo: Will exclude collections: ${actualExcluded.join(', ')}`);
        }
      } else if (intendedMode === 'exclude') {
        actualExcluded = collectionsList;
        actualMode = 'exclude';
        actualSelected = [];
      } else {
        // 'all' mode
        actualMode = 'all';
        actualSelected = [];
        actualExcluded = [];
      }

      spinner.text = `Running backup process for ${source.name}...`;
      // 3. Call BackupService with transformed parameters
      const backupFilename = await this.backupService.createBackup(source, actualSelected, actualExcluded, actualMode);

      spinner.text = `Saving metadata for ${backupFilename}...`;
      // 4. Save metadata using the *original* intent from args
      const now = new Date();
      const metadata: BackupMetadata = {
        source: source.name,
        database: source.database,
        selectionMode: intendedMode, // Use the original mode from args
        includedCollections: intendedMode === 'include' ? collectionsList : undefined,
        excludedCollections: intendedMode === 'exclude' ? collectionsList : undefined,
        timestamp: now.getTime(),
        date: now.toISOString(),
        archivePath: path.basename(backupFilename),
      };
      const metadataPath = `${backupFilename}.json`;
      fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));

      spinner.succeed(`Backup created successfully: ${backupFilename}\nMetadata saved: ${metadataPath}`);
    } catch (error: any) {
      spinner.fail(`Backup from arguments failed: ${error.message}`);
      throw error; // Re-throw error to be caught by the caller (mongodb-app.ts)
    } finally {
      if (this.mongoService.getClient()) {
        await this.mongoService.close();
      }
    }
  }
}
