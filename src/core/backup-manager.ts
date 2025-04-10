import ora from 'ora';
import path from 'path'; // Needed for metadata path
import fs from 'fs'; // Needed for saving metadata

import { MongoDBService } from '../services/mongodb.service';
import { BackupService } from '../services/backup.service';

import { PromptService } from '../utils/prompts';
import { AppConfig, BackupPreset, BackupMetadata, ConnectionConfig } from '../types/index';

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
    let source: ConnectionConfig | undefined; // Define source here for finally block
    try {
      spinner.stop();

      // Get user intent including potential startTime
      const {
        source: promptedSource, // Rename to avoid conflict in scope
        selectedCollections: intendedIncluded, // User's selection for include
        excludedCollections: intendedExcluded, // User's selection for exclude
        selectionMode: intendedMode,
        startTime, // Will be defined only if mode=include and 1 collection selected
      } = await this.promptService.promptForBackup();
      source = promptedSource; // Assign to outer scope variable

      spinner.start(`Preparing backup for ${source.name}...`);
      if (startTime) {
        spinner.text = `Preparing backup for ${source.name}, collection ${intendedIncluded[0]} (since ${startTime.toISOString()})...`;
      }

      let actualMode: 'all' | 'include' | 'exclude';
      let actualSelected: string[] = []; // Collections for --collection flag
      let actualExcluded: string[] = []; // Collections for --excludeCollection flag
      const collectionsListForMetadata = intendedIncluded.length > 0 ? intendedIncluded : intendedExcluded; // For metadata

      // --- Determine actual parameters for mongodump ---
      if (startTime) {
        // Time filter case: Must use --collection
        actualMode = 'include'; // Force include mode for backup service
        actualSelected = intendedIncluded; // Should be the single selected collection
        actualExcluded = [];
        spinner.text = `Running backup for single collection ${actualSelected[0]} with time filter...`;
      } else {
        // No time filter - use existing logic
        spinner.text = `Calculating collections for ${source.name}...`;
        if (intendedMode === 'include') {
          // Transform 'include' intent to 'exclude' command if multiple collections or no time filter
          if (intendedIncluded.length === 0) {
            console.warn(
              'Warning: Include mode selected but no collections were chosen or fetched. Backing up all collections.',
            );
            actualMode = 'all';
          } else {
            try {
              await this.mongoService.connect(source);
              const allCollections = await this.mongoService.getCollections(source.database);
              await this.mongoService.close();

              actualExcluded = allCollections.filter((coll) => !intendedIncluded.includes(coll));

              if (actualExcluded.length === 0 && allCollections.length > 0) {
                console.log(
                  `Info: All collections in ${source.database} were specified for inclusion. Switching to 'all' mode.`,
                );
                actualMode = 'all';
                actualSelected = []; // Ensure empty
              } else if (actualExcluded.length === allCollections.length && allCollections.length > 0) {
                console.warn(
                  `Warning: None of the specified collections (${intendedIncluded.join(', ')}) were found. Backing up all collections (excluding none).`,
                );
                actualMode = 'all'; // Effectively all if nothing to exclude
                actualExcluded = []; // Ensure empty
              } else {
                console.log(`Info: Will exclude collections: ${actualExcluded.join(', ')}`);
                actualMode = 'exclude';
                actualSelected = []; // Ensure empty
              }
            } catch (error: any) {
              spinner.fail(`Failed to fetch all collections to calculate exclusions: ${error.message}`);
              console.warn('Falling back to backing up all collections.');
              actualMode = 'all';
              actualSelected = [];
              actualExcluded = [];
            }
          }
        } else if (intendedMode === 'exclude') {
          actualMode = 'exclude';
          actualExcluded = intendedExcluded; // Use directly provided exclusions
          actualSelected = [];
          console.log(`Info: Excluding collections: ${actualExcluded.join(', ')}`);
        } else {
          // intendedMode === 'all'
          actualMode = 'all';
          actualSelected = [];
          actualExcluded = [];
          console.log('Info: Backing up all collections.');
        }
      }
      // --- End Parameter Determination ---

      spinner.text = `Running backup process for ${source.name}...`;
      const backupFilename = await this.backupService.createBackup(
        source,
        actualSelected, // Use calculated selected (only for single collection + time)
        actualExcluded, // Use calculated excluded
        actualMode, // Use calculated mode ('include', 'exclude', or 'all')
        startTime, // Pass startTime
      );

      spinner.text = `Saving metadata for ${backupFilename}...`;
      const now = new Date();
      const metadata: BackupMetadata = {
        source: source.name,
        database: source.database,
        selectionMode: intendedMode, // Store the *user's* intended mode
        // Store user's intended collections based on their mode
        includedCollections: intendedMode === 'include' ? collectionsListForMetadata : undefined,
        excludedCollections: intendedMode === 'exclude' ? collectionsListForMetadata : undefined,
        timestamp: now.getTime(),
        date: now.toISOString(),
        archivePath: path.basename(backupFilename),
        presetName: undefined, // Not using preset here
        queryStartTime: startTime ? startTime.toISOString() : undefined, // Save if time filter was used
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
      // Ensure connection is closed even on error during prompts/backup
      if (source && this.mongoService.getClient()) {
        await this.mongoService.close();
        console.log(`[${source.name}] Connection closed.`);
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

      spinner.text = `Starting backup using preset: ${preset.name}...`;

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
   * Performs a backup based on non-interactive arguments passed from MongoDBApp.
   * @param sourceName - Name of the source connection.
   * @param backupMode - The mode specified ('all', 'include', 'exclude').
   * @param collections - The list of collections specified (for include/exclude).
   * @param startTime - Optional start time filter (requires mode=include, collections.length=1).
   */
  async backupFromArgs(
    sourceName: string,
    backupMode: 'all' | 'include' | 'exclude',
    collections: string[],
    startTime?: Date,
  ): Promise<void> {
    const spinner = ora(`Starting backup from arguments for ${sourceName}...`).start();
    const source = this.config.connections.find((conn) => conn.name === sourceName);
    if (!source) {
      spinner.fail(`Source connection "${sourceName}" not found.`);
      throw new Error(`Source connection "${sourceName}" not found.`);
    }

    try {
      let actualMode: 'all' | 'include' | 'exclude';
      let actualSelected: string[] = [];
      let actualExcluded: string[] = [];

      // --- Determine actual parameters for mongodump ---
      if (startTime) {
        // Validation already done in MongoDBApp
        actualMode = 'include';
        actualSelected = collections; // The single collection
        actualExcluded = [];
        spinner.text = `Preparing backup for single collection ${actualSelected[0]} with time filter...`;
      } else {
        // No time filter - determine mode based on input args
        if (backupMode === 'include') {
          // Transform 'include' intent to 'exclude' command
          if (collections.length === 0) {
            console.warn('Warning: Include mode specified but no collections provided. Backing up all collections.');
            actualMode = 'all';
          } else {
            try {
              spinner.text = `Fetching collections from ${source.name} to calculate exclusions...`;
              await this.mongoService.connect(source);
              const allCollections = await this.mongoService.getCollections(source.database);
              await this.mongoService.close();
              spinner.succeed(`Fetched ${allCollections.length} collections.`);

              actualExcluded = allCollections.filter((coll) => !collections.includes(coll));

              if (actualExcluded.length === 0 && allCollections.length > 0) {
                console.log("Info: All collections were specified for inclusion. Switching to 'all' mode.");
                actualMode = 'all';
              } else if (actualExcluded.length === allCollections.length && allCollections.length > 0) {
                console.warn(
                  `Warning: None of the specified collections (${collections.join(', ')}) were found. Backing up all collections.`,
                );
                actualMode = 'all';
                actualExcluded = [];
              } else {
                console.log(`Info: Will exclude collections: ${actualExcluded.join(', ')}`);
                actualMode = 'exclude';
              }
            } catch (error: any) {
              spinner.fail(`Failed to fetch all collections: ${error.message}`);
              console.warn('Falling back to backing up all collections.');
              actualMode = 'all';
              actualExcluded = [];
            }
          }
        } else if (backupMode === 'exclude') {
          actualMode = 'exclude';
          actualExcluded = collections; // Use directly provided exclusions
          console.log(`Info: Excluding collections: ${actualExcluded.join(', ')}`);
        } else {
          // backupMode === 'all'
          actualMode = 'all';
          actualExcluded = [];
          console.log('Info: Backing up all collections.');
        }
      }
      // --- End Parameter Determination ---

      spinner.start(`Running backup process for ${source.name}...`);
      const backupFilename = await this.backupService.createBackup(
        source,
        actualSelected,
        actualExcluded,
        actualMode,
        startTime,
      );

      spinner.text = `Saving metadata for ${backupFilename}...`;
      const now = new Date();
      const metadata: BackupMetadata = {
        source: source.name,
        database: source.database,
        selectionMode: backupMode, // Store the mode provided in args
        includedCollections: backupMode === 'include' ? collections : undefined,
        excludedCollections: backupMode === 'exclude' ? collections : undefined,
        timestamp: now.getTime(),
        date: now.toISOString(),
        archivePath: path.basename(backupFilename),
        presetName: undefined, // Not using preset here
        queryStartTime: startTime ? startTime.toISOString() : undefined,
      };
      const metadataPath = `${backupFilename}.json`;
      fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));

      spinner.succeed(`Backup created successfully: ${backupFilename}\nMetadata saved: ${metadataPath}`);
    } catch (error: any) {
      spinner.fail(`Backup from arguments failed: ${error.message}`);
      throw error; // Re-throw error to be caught by the caller (mongodb-app.ts)
    } finally {
      // Ensure connection is closed even on error
      if (this.mongoService.getClient()) {
        await this.mongoService.close();
        console.log(`[${source.name}] Connection closed.`);
      }
    }
  }
}
