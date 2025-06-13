import path from 'path';
import fs from 'fs';
import { parseISO, isValid } from 'date-fns';

import { MongoDBService } from '../services/mongodb.service';
import { BackupService } from '../services/backup.service';

import { PromptService } from '../services/prompt-service';
import { AppConfig, BackupPreset, BackupMetadata, ConnectionConfig } from '../types/index';
import { Logger } from '../utils/logger';

/**
 * Manages the backup process, coordinating user prompts, backup service, and metadata generation.
 */
export class BackupController {
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
    this.logger.startSpinner('Starting interactive backup...');
    let source: ConnectionConfig | undefined;
    try {
      this.logger.stopSpinner();

      const {
        source: promptedSource,
        selectedCollections: intendedIncluded,
        excludedCollections: intendedExcluded,
        selectionMode: intendedMode,
        startTime,
      } = await this.promptService.promptForBackup();
      source = promptedSource;

      this.logger.startSpinner(`Preparing backup for ${source.name}...`);
      if (startTime) {
        this.logger.updateSpinner(
          `Preparing backup for ${source.name}, collection ${intendedIncluded[0]} (since ${startTime.toISOString()})...`,
        );
      }

      const { actualMode, actualSelected, actualExcluded } = await this.getActualBackupParams(
        intendedMode,
        intendedIncluded,
        intendedExcluded,
        startTime,
        source,
        'interactive',
      );
      const collectionsListForMetadata = intendedIncluded.length > 0 ? intendedIncluded : intendedExcluded;

      this.logger.stopSpinner();
      const backupFilename = await this.backupService.createBackup(
        source,
        actualSelected,
        actualExcluded,
        actualMode,
        startTime,
      );

      this.logger.startSpinner(`Saving metadata for ${backupFilename}...`);
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
        presetName: undefined,
        queryStartTime: startTime ? startTime.toISOString() : undefined,
      };
      const metadataPath = `${backupFilename}.json`;
      fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));

      this.logger.succeedSpinner(`Backup created successfully: ${backupFilename} | Metadata saved: ${metadataPath}`);
    } catch (error: any) {
      if (this.logger.spinner?.isSpinning) {
        this.logger.failSpinner(`Interactive backup failed: ${error.message}`);
      } else {
        this.logger.error(`Interactive backup failed: ${error.message}`);
      }
    } finally {
      if (source && this.mongoService.getClient()) {
        await this.mongoService.close();
        this.logger.info(`[${source.name}] Connection closed.`);
      }
      if (this.logger.spinner?.isSpinning) {
        this.logger.stopSpinner();
      }
    }
  }

  async manageBackupPresets(): Promise<void> {
    const selectedPresetAction = await this.promptService.managePresets();

    if (selectedPresetAction && selectedPresetAction.type === 'backup') {
      const preset = selectedPresetAction.preset as BackupPreset;
      this.logger.info(`Using backup preset: ${preset.name}`);
      await this.useBackupPreset(preset);
    }
  }

  /**
   * Executes a backup using a predefined preset.
   * @param preset - The backup preset configuration.
   */
  async useBackupPreset(preset: BackupPreset): Promise<void> {
    this.logger.startSpinner(`Loading preset "${preset.name}"...`);
    let source: ConnectionConfig | undefined;
    let startTime: Date | undefined; // Variable to hold parsed start time

    try {
      source = this.config.connections.find((c) => c.name === preset.sourceName);
      if (!source) {
        throw new Error(
          `Source connection "${preset.sourceName}" defined in preset "${preset.name}" not found in config.`,
        );
      }

      this.logger.updateSpinner(`Preparing backup for preset "${preset.name}" (Source: ${source.name})...`);

      let actualMode: 'all' | 'include' | 'exclude' = 'all';
      let actualSelected: string[] = [];
      let actualExcluded: string[] = [];
      const collections = preset.collections || [];
      let collectionsListForMetadata = collections;

      if (preset.queryStartTime && preset.selectionMode === 'include' && collections.length === 1) {
        startTime = parseISO(preset.queryStartTime);
        if (!isValid(startTime)) {
          this.logger.warn(
            `Invalid queryStartTime format "${preset.queryStartTime}" in preset "${preset.name}". Ignoring time filter.`,
          );
          startTime = undefined;
        }
      }

      ({ actualMode, actualSelected, actualExcluded } = await this.getActualBackupParams(
        preset.selectionMode,
        collections,
        collections,
        startTime,
        source,
        `preset:${preset.name}`,
      ));
      collectionsListForMetadata = collections;

      this.logger.stopSpinner();
      this.logger.info('Creating backup with preset');
      this.logger.info(preset);
      const backupFilename = await this.backupService.createBackup(
        source,
        actualSelected,
        actualExcluded,
        actualMode,
        startTime,
      );

      this.logger.startSpinner(`Saving metadata for preset backup ${backupFilename}...`);
      const now = new Date();
      const metadata: BackupMetadata = {
        source: source.name,
        database: source.database,
        selectionMode: preset.selectionMode,
        includedCollections: preset.selectionMode === 'include' ? collectionsListForMetadata : undefined,
        excludedCollections: preset.selectionMode === 'exclude' ? collectionsListForMetadata : undefined,
        timestamp: now.getTime(),
        date: now.toISOString(),
        archivePath: path.basename(backupFilename),
        presetName: preset.name,
        queryStartTime: startTime?.toISOString(),
      };
      const metadataPath = `${backupFilename}.json`;
      fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));

      this.logger.succeedSpinner(
        `Preset backup "${preset.name}" created successfully: ${backupFilename} | Metadata saved: ${metadataPath}`,
      );
    } catch (error: any) {
      this.logger.failSpinner(`Backup from preset "${preset.name}" failed: ${error.message}`);
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
    this.logger.startSpinner(`Starting backup from arguments for ${sourceName}...`);
    const source = this.config.connections.find((conn) => conn.name === sourceName);
    if (!source) {
      this.logger.failSpinner(`Source connection "${sourceName}" not found.`);
      throw new Error(`Source connection "${sourceName}" not found.`);
    }

    try {
      const { actualMode, actualSelected, actualExcluded } = await this.getActualBackupParams(
        backupMode,
        collections,
        collections,
        startTime,
        source,
        'args',
      );

      this.logger.startSpinner(`Running backup process for ${source.name}...`);
      const backupFilename = await this.backupService.createBackup(
        source,
        actualSelected,
        actualExcluded,
        actualMode,
        startTime,
      );

      this.logger.updateSpinner(`Saving metadata for ${backupFilename}...`);
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

      this.logger.succeedSpinner(`Backup created successfully: ${backupFilename} | Metadata saved: ${metadataPath}`);
    } catch (error: any) {
      this.logger.failSpinner(`Backup from arguments failed: ${error.message}`);
      throw error; // Re-throw error to be caught by the caller (mongodb-app.ts)
    } finally {
      // Ensure connection is closed even on error
      if (this.mongoService.getClient()) {
        await this.mongoService.close();
      }
      // Ensure spinner is stopped
      if (this.logger.spinner?.isSpinning) {
        this.logger.stopSpinner();
      }
    }
  }

  /**
   * Helper to determine the effective backup parameters (mode, included/excluded collections)
   * based on user intent, time filter, and available collections.
   * Reduces complexity by using early returns and clear branches.
   */
  private async getActualBackupParams(
    mode: 'all' | 'include' | 'exclude',
    included: string[],
    excluded: string[],
    startTime: Date | undefined,
    source: ConnectionConfig,
    contextLabel: string,
  ): Promise<{ actualMode: 'all' | 'include' | 'exclude'; actualSelected: string[]; actualExcluded: string[] }> {
    // Time filter always means include mode for a single collection
    if (startTime) {
      this.logger.updateSpinner(
        `[${contextLabel}] Backup single collection with time filter: ${included[0]} (>= ${startTime.toISOString()})...`,
      );
      return {
        actualMode: 'include',
        actualSelected: included,
        actualExcluded: [],
      };
    }

    this.logger.updateSpinner(`[${contextLabel}] Calculating collection set...`);

    // INCLUDE mode logic
    if (mode === 'include') {
      if (included.length === 0) {
        this.logger.warn(
          `[${contextLabel}] Include mode selected but no collections specified. Backing up all collections.`,
        );
        return {
          actualMode: 'all',
          actualSelected: [],
          actualExcluded: [],
        };
      }
      try {
        await this.mongoService.connect(source);
        const allCollections = await this.mongoService.getCollections(source.database);
        await this.mongoService.close();
        const actualExcluded = allCollections.filter((coll) => !included.includes(coll));
        if (actualExcluded.length === 0 && allCollections.length > 0) {
          this.logger.info(`[${contextLabel}] All collections in DB specified for inclusion. Switching to 'all' mode.`);
          return {
            actualMode: 'all',
            actualSelected: [],
            actualExcluded: [],
          };
        }
        if (actualExcluded.length === allCollections.length && allCollections.length > 0) {
          this.logger.warn(
            `[${contextLabel}] None of the specified collections (${included.join(', ')}) found. Backing up all collections.`,
          );
          return {
            actualMode: 'all',
            actualSelected: [],
            actualExcluded: [],
          };
        }
        this.logger.info(`[${contextLabel}] Will exclude collections: ${actualExcluded.join(', ')}`);
        return {
          actualMode: 'exclude',
          actualSelected: [],
          actualExcluded,
        };
      } catch (error: any) {
        this.logger.failSpinner(`[${contextLabel}] Failed to fetch collection list: ${error.message}`);
        this.logger.warn(`[${contextLabel}] Fallback to backing up all collections.`);
        return {
          actualMode: 'all',
          actualSelected: [],
          actualExcluded: [],
        };
      }
    }

    // EXCLUDE mode logic
    if (mode === 'exclude') {
      this.logger.info(`[${contextLabel}] Excluding collections: ${excluded.join(', ')}`);
      return {
        actualMode: 'exclude',
        actualSelected: [],
        actualExcluded: excluded,
      };
    }

    // ALL mode logic (default)
    this.logger.info(`[${contextLabel}] Backing up all collections.`);
    return {
      actualMode: 'all',
      actualSelected: [],
      actualExcluded: [],
    };
  }
}
