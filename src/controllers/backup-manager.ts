import ora from 'ora';
import path from 'path'; // Needed for metadata path
import fs from 'fs'; // Needed for saving metadata
import { parseISO, isValid } from 'date-fns'; // Import parseISO and isValid

import { MongoDBService } from '../services/mongodb.service';
import { BackupService } from '../services/backup.service';

import { PromptService } from '../services/prompt-service';
import { AppConfig, BackupPreset, BackupMetadata, ConnectionConfig } from '../types/index';
import { Logger } from '../utils/logger';

/**
 * Manages the backup process, coordinating user prompts, backup service, and metadata generation.
 */
export class BackupManager {
  constructor(
    private readonly config: AppConfig,
    private readonly promptService: PromptService,
    private readonly mongoService: MongoDBService,
    private readonly backupService: BackupService,
    private readonly logger: Logger,
  ) {}

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

      spinner.stop();
      const backupFilename = await this.backupService.createBackup(
        source,
        actualSelected, // Use calculated selected (only for single collection + time)
        actualExcluded, // Use calculated excluded
        actualMode, // Use calculated mode ('include', 'exclude', or 'all')
        startTime, // Pass startTime
      );

      spinner.start(`Saving metadata for ${backupFilename}...`);
      const now = new Date();
      const metadata: BackupMetadata = {
        source: source.name,
        database: source.database,
        selectionMode: intendedMode,
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
   * Executes a backup using a predefined preset.
   * @param preset - The backup preset configuration.
   */
  async useBackupPreset(preset: BackupPreset): Promise<void> {
    const spinner = ora(`Loading preset "${preset.name}"...`).start();
    let source: ConnectionConfig | undefined;
    let startTime: Date | undefined; // Variable to hold parsed start time

    try {
      source = this.config.connections.find((c) => c.name === preset.sourceName);
      if (!source) {
        throw new Error(
          `Source connection "${preset.sourceName}" defined in preset "${preset.name}" not found in config.`,
        );
      }

      spinner.text = `Preparing backup for preset "${preset.name}" (Source: ${source.name})...`;

      // Initialize actualMode to satisfy the compiler.
      // The subsequent logic will assign the correct value based on conditions.
      let actualMode: 'all' | 'include' | 'exclude' = 'all';
      let actualSelected: string[] = [];
      let actualExcluded: string[] = [];
      const collections = preset.collections || [];

      // --- Determine mode, collections, and startTime ---
      console.log('==check==', preset.queryStartTime, preset.selectionMode, collections.length);

      if (preset.queryStartTime && preset.selectionMode === 'include' && collections.length === 1) {
        // --- Time Filter Case ---
        startTime = parseISO(preset.queryStartTime);
        if (!isValid(startTime)) {
          spinner.warn(
            `Invalid queryStartTime format "${preset.queryStartTime}" in preset "${preset.name}". Ignoring time filter.`,
          );
          startTime = undefined;
          // Fallback logic will run below in the `if (!startTime)` block
        } else {
          actualMode = 'include';
          actualSelected = collections;
          actualExcluded = [];
          spinner.info(
            `Preset "${preset.name}" uses time filter for collection "${actualSelected[0]}" (>= ${startTime.toISOString()}).`,
          );
          // Skip the standard include->exclude conversion logic
        }
      }

      // --- Standard Mode Determination (if no valid time filter) ---
      if (!startTime) {
        // Only run if startTime was not successfully set above
        if (preset.selectionMode === 'include') {
          await this.mongoService.connect(source);
          const allCollections = await this.mongoService.getCollections(source.database);
          await this.mongoService.close(); // Close connection after listing

          actualExcluded = allCollections.filter((coll) => !collections.includes(coll));

          if (actualExcluded.length === 0 && allCollections.length > 0) {
            spinner.info(
              `Preset "${preset.name}": All collections were specified for inclusion. Switching to 'all' mode.`,
            );
            actualMode = 'all';
          } else if (actualExcluded.length === allCollections.length && allCollections.length > 0) {
            spinner.warn(
              `Preset "${preset.name}": Included collections do not exist in the source. Backing up nothing.`,
            );
            // Or potentially switch to 'all' mode? For now, let it proceed (will likely backup nothing).
            actualMode = 'exclude'; // Technically excluding everything
          } else {
            actualMode = 'exclude';
            spinner.info(
              `Preset "${preset.name}": Mode 'include' transformed to 'exclude' (${actualExcluded.length} collections).`,
            );
          }
        } else if (preset.selectionMode === 'exclude') {
          actualMode = 'exclude';
          actualExcluded = collections;
          spinner.info(`Preset "${preset.name}": Mode 'exclude' (${actualExcluded.length} collections).`);
        } else {
          actualMode = 'all';
          actualExcluded = [];
          spinner.info(`Preset "${preset.name}": Mode 'all'.`);
        }
      }
      // --- End Determination ---

      spinner.stop();
      console.log('Creating backup with preset');
      console.log('========================================\n');
      console.log(preset);
      console.log('========================================\n');
      const backupFilename = await this.backupService.createBackup(
        source,
        actualSelected,
        actualExcluded,
        actualMode,
        startTime,
      );

      spinner.start(`Saving metadata for preset backup ${backupFilename}...`);
      const now = new Date();
      const metadata: BackupMetadata = {
        source: source.name,
        database: source.database,
        selectionMode: preset.selectionMode,
        includedCollections: preset.selectionMode === 'include' ? collections : undefined,
        excludedCollections: preset.selectionMode === 'exclude' ? collections : undefined,
        timestamp: now.getTime(),
        date: now.toISOString(),
        archivePath: path.basename(backupFilename),
        presetName: preset.name,
        queryStartTime: startTime?.toISOString(),
      };
      const metadataPath = `${backupFilename}.json`;
      fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));

      spinner.succeed(
        `Preset backup "${preset.name}" created successfully: ${backupFilename}\nMetadata saved: ${metadataPath}`,
      );
    } catch (error: any) {
      spinner.fail(`Backup from preset "${preset.name}" failed: ${error.message}`);
      throw error; // Re-throw for handling in mongodb-app.ts
    } finally {
      // Ensure connection is closed if it was opened
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
                console.log('Info: All collections were specified for inclusion. Switching to all mode.');
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
      }
      // Ensure spinner is stopped
      if (spinner.isSpinning) {
        spinner.stop();
      }
    }
  }
}
