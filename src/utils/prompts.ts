import inquirer from 'inquirer';
import type { AppConfig, ConnectionConfig, BackupMetadata, BackupPreset } from '../types';
import { BackupService } from '../services/backup.service';
import { MongoDBService } from '../services/mongodb.service';
import { savePresets } from '../utils';
import ora from 'ora';
import { subDays, parseISO, isValid, subHours, subWeeks, subMonths, subYears } from 'date-fns';

/**
 * Provides services for interacting with the user via command-line prompts (inquirer).
 */
export class PromptService {
  private config: AppConfig;
  private backupService: BackupService;
  private mongoService: MongoDBService;

  /**
   * Creates an instance of PromptService.
   * @param config - The application configuration.
   */
  constructor(config: AppConfig) {
    this.config = config;
    this.mongoService = new MongoDBService(config);
    this.backupService = new BackupService(config);
  }

  /**
   * Prompts the user for backup configuration details: source connection, selection mode, and collections.
   * Fetches collection list from the source database if possible.
   * @returns A promise resolving to the user's backup configuration choices.
   */
  async promptForBackup(): Promise<{
    source: ConnectionConfig;
    selectedCollections: string[];
    excludedCollections: string[];
    selectionMode: 'all' | 'include' | 'exclude';
    startTime?: Date;
  }> {
    console.log('DEBUG: Entering promptForBackup...');

    if (!this.config.connections || this.config.connections.length === 0) {
      console.error('No connections found in the configuration.');
      throw new Error('No connections found in the configuration.');
    }

    console.log('DEBUG: Prompting for source...');
    const { sourceName } = await inquirer.prompt<{ sourceName: string }>([
      {
        type: 'list',
        name: 'sourceName',
        message: 'Select source connection for backup:',
        choices: this.config.connections.map((conn) => conn.name),
      },
    ]);
    const source = this.config.connections.find((conn) => conn.name === sourceName);

    if (!source) {
      console.error(`Source connection "${sourceName}" not found in the configuration.`);
      throw new Error(`Source connection "${sourceName}" not found in the configuration.`);
    }

    console.log(`DEBUG: Source selected: ${sourceName}`);

    console.log('DEBUG: Prompting for mode...');
    const { selectionModeChoice } = await inquirer.prompt<{ selectionModeChoice: string }>([
      {
        type: 'list',
        name: 'selectionModeChoice',
        message: 'Select collection backup mode:',
        choices: [
          { name: 'Backup ALL collections', value: 'all' },
          { name: 'INCLUDE specific collections only', value: 'include' },
          { name: 'EXCLUDE specific collections', value: 'exclude' },
        ],
        default: 'all',
      },
    ]);
    const selectionMode = selectionModeChoice as 'all' | 'include' | 'exclude';
    console.log(`DEBUG: Mode selected: ${selectionMode}`);

    let selectedCollections: string[] = [];
    let excludedCollections: string[] = [];
    let startTime: Date | undefined = undefined;

    if (selectionMode === 'include' || selectionMode === 'exclude') {
      console.log('DEBUG: Mode requires fetching collections.');
      let collections: string[] = [];
      const fetchSpinner = ora(`Fetching collections from ${source.name}...`).start();
      try {
        console.log('DEBUG: Connecting to MongoDB...');
        await this.mongoService.connect(source);
        console.log('DEBUG: Connected. Fetching collections...');
        collections = await this.mongoService.getCollections(source.database);
        console.log(`DEBUG: Fetched ${collections.length} collections. Closing connection...`);
        await this.mongoService.close();
        console.log('DEBUG: Connection closed.');
        fetchSpinner.succeed(`Fetched ${collections.length} collections from ${source.name}.`);

        if (collections.length === 0) {
          console.log('No collections found in the source database.');
          return { source, selectedCollections: [], excludedCollections: [], selectionMode: 'all', startTime };
        }

        console.log('DEBUG: Prompting for collections...');
        if (selectionMode === 'include') {
          const { chosenCollections } = await inquirer.prompt<{ chosenCollections: string[] }>([
            {
              type: 'checkbox',
              name: 'chosenCollections',
              message: 'Select collections to INCLUDE in backup:',
              choices: collections.map((coll) => ({ name: coll, value: coll })),
              validate: (answer) => {
                if (answer.length === 0) {
                  return 'Please select at least one collection to include.';
                }
                return true;
              },
            },
          ]);
          selectedCollections = chosenCollections;
          if (selectedCollections.length === 1) {
            console.log('DEBUG: Single collection included, prompting for time filter...');
            startTime = await this.promptForTimeFilter();
          } else if (selectedCollections.length > 1) {
            console.log('DEBUG: Multiple collections included, time filter (--query) is not applicable.');
          }
        } else {
          const { excluded } = await inquirer.prompt<{ excluded: string[] }>({
            type: 'checkbox',
            name: 'excluded',
            message: 'Select collections to EXCLUDE from backup (optional):',
            choices: collections.map((coll) => ({ name: coll, value: coll, checked: false })),
          });
          excludedCollections = excluded;
        }
        console.log('DEBUG: Collections selected.');
      } catch (error: any) {
        console.error('DEBUG: Error during collection fetch/prompt:', error);
        throw error;
      }
    }

    console.log('DEBUG: Returning from promptForBackup.');
    return { source, selectedCollections, excludedCollections, selectionMode, startTime };
  }

  /**
   * Helper function to prompt for the time filter choice.
   * @returns The selected start time Date object, or undefined if no filter is chosen.
   */
  private async promptForTimeFilter(): Promise<Date | undefined> {
    console.log('DEBUG: Prompting for time filter...');
    const { timeFilterChoice } = await inquirer.prompt<{ timeFilterChoice: string }>([
      {
        type: 'list',
        name: 'timeFilterChoice',
        message: 'Apply time filter? (Backup documents created/updated after a certain time based on _id):',
        choices: [
          { name: 'No filter (Full collection backup)', value: 'none' },
          new inquirer.Separator('-- Relative --'),
          { name: 'Since 1 Hour Ago', value: '1h' },
          { name: 'Since 6 Hours Ago', value: '6h' },
          { name: 'Since 12 Hours Ago', value: '12h' },
          { name: 'Since 1 Day Ago', value: '1d' },
          { name: 'Since 3 Days Ago', value: '3d' },
          { name: 'Since 1 Week Ago', value: '1w' },
          { name: 'Since 1 Month Ago', value: '1M' },
          new inquirer.Separator('-- Absolute --'),
          { name: 'Custom Date/Time', value: 'custom' },
          new inquirer.Separator(),
        ],
        default: 'none',
        pageSize: 15,
      },
    ]);

    let startTime: Date | undefined = undefined;
    const now = new Date();

    if (timeFilterChoice === 'none' || timeFilterChoice === 'custom') {
      // Handle 'none' and 'custom' below
    } else {
      const match = timeFilterChoice.match(/^(\d+)([hdwMy])$/);
      if (match) {
        const value = parseInt(match[1], 10);
        const unit = match[2];
        try {
          if (unit === 'h') startTime = subHours(now, value);
          else if (unit === 'd') startTime = subDays(now, value);
          else if (unit === 'w') startTime = subWeeks(now, value);
          else if (unit === 'M') startTime = subMonths(now, value);
          else if (unit === 'y') startTime = subYears(now, value);
          console.log(`DEBUG: Relative time filter set to ${value}${unit} ago: ${startTime?.toISOString()}`);
        } catch (e) {
          console.error(`Error calculating relative date for ${timeFilterChoice}: ${e}`);
          startTime = undefined;
        }
      }
    }

    if (timeFilterChoice === 'custom') {
      const { customTimeString } = await inquirer.prompt<{ customTimeString: string }>([
        {
          type: 'input',
          name: 'customTimeString',
          message: 'Enter start date/time (ISO 8601 format, e.g., YYYY-MM-DDTHH:mm:ssZ):',
          validate: (input: string) => {
            const parsedDate = parseISO(input);
            return isValid(parsedDate) || 'Invalid date format. Please use ISO 8601 (e.g., 2023-10-27T10:00:00Z).';
          },
        },
      ]);
      try {
        startTime = parseISO(customTimeString);
        if (!isValid(startTime)) throw new Error('Invalid date parsed');
        console.log(`DEBUG: Custom time filter set to: ${startTime.toISOString()}`);
      } catch (e) {
        console.error(`Error parsing custom date string "${customTimeString}": ${e}`);
        startTime = undefined;
      }
    }

    if (!startTime) {
      console.log('DEBUG: No time filter applied.');
    }
    return startTime;
  }

  /**
   * Prompts the user to select a backup file, target connection, and restore options.
   * Displays metadata of the selected backup file.
   * @returns A promise resolving to the user's restore configuration choices.
   * @throws An error if no backup files are found or metadata cannot be loaded.
   */
  async promptForRestore(): Promise<{
    target: ConnectionConfig;
    backupFile: string;
    options: { drop: boolean };
  }> {
    const backupFiles = this.backupService.getBackupFiles();

    if (backupFiles.length === 0) {
      throw new Error('No backup files found in the backup directory.');
    }

    const { backupFile } = await inquirer.prompt({
      type: 'list',
      name: 'backupFile',
      message: 'Select backup file to restore (newest first):',
      choices: backupFiles,
      pageSize: 15,
    });

    let backupMetadata: BackupMetadata;
    try {
      backupMetadata = this.backupService.loadBackupMetadata(backupFile);
      console.log('\n--- Selected Backup Metadata ---');
      console.log(`Source Connection: ${backupMetadata.source}`);
      console.log(`Database:          ${backupMetadata.database || 'N/A (Older Backup?)'}`);
      console.log(`Created At:        ${new Date(backupMetadata.timestamp).toLocaleString()}`);
      console.log(`Selection Mode:    ${backupMetadata.selectionMode}`);
      if (
        backupMetadata.selectionMode === 'include' &&
        Array.isArray(backupMetadata.includedCollections) &&
        backupMetadata.includedCollections.length > 0
      ) {
        console.log(`Included Collections: ${backupMetadata.includedCollections.join(', ')}`);
      } else if (
        backupMetadata.selectionMode === 'exclude' &&
        Array.isArray(backupMetadata.excludedCollections) &&
        backupMetadata.excludedCollections.length > 0
      ) {
        console.log(`Excluded Collections: ${backupMetadata.excludedCollections.join(', ')}`);
      }
      console.log('------------------------------\n');
    } catch (error: any) {
      console.error(`\nError loading metadata for ${backupFile}: ${error.message}`);
      throw new Error(`Failed to load metadata for selected backup: ${error.message}`);
    }

    const { target } = await inquirer.prompt({
      type: 'list',
      name: 'target',
      message: 'Select target connection for restore:',
      choices: this.config.connections.map((conn) => ({
        name: `${conn.name} (${conn.database})`,
        value: conn,
      })),
    });

    const { drop } = await inquirer.prompt({
      type: 'confirm',
      name: 'drop',
      message: `Drop existing collections in target database "${target.database}" before restore?`,
      default: false,
    });

    return {
      backupFile,
      target,
      options: { drop },
    };
  }

  async promptForRestoreTarget(
    backupMetadata: BackupMetadata,
    excludeSource?: ConnectionConfig,
  ): Promise<{ target: ConnectionConfig; options: { drop: boolean } }> {
    const availableConnections = excludeSource
      ? this.config.connections.filter((conn) => conn.name !== excludeSource.name)
      : this.config.connections;

    if (availableConnections.length === 0) {
      throw new Error('No available target connections found (excluding the source).');
    }

    const { targetIndex } = await inquirer.prompt({
      type: 'list',
      name: 'targetIndex',
      message: 'Select target connection for restore:',
      choices: availableConnections.map((conn, index) => ({
        name: `${conn.name} (${conn.database})`,
        value: index,
      })),
    });

    const target = availableConnections[targetIndex];

    if (backupMetadata.database && target.database && backupMetadata.database !== target.database) {
      const { confirmDifferentDB } = await inquirer.prompt({
        type: 'confirm',
        name: 'confirmDifferentDB',
        message: `Warning: Source database (${backupMetadata.database}) and target database (${target.database}) names differ. Continue restore?`,
        default: true,
      });

      if (!confirmDifferentDB) {
        throw new Error('Restore canceled by user due to database name mismatch.');
      }
    }

    const { drop } = await inquirer.prompt({
      type: 'confirm',
      name: 'drop',
      message: `Drop existing collections in target database "${target.database}" before restore?`,
      default: false,
    });

    const options = { drop };

    return { target, options };
  }

  async promptForBackupPreset(): Promise<BackupPreset> {
    const { name, description } = await inquirer.prompt([
      {
        type: 'input',
        name: 'name',
        message: 'Enter a unique name for the backup preset:',
        validate: (input: string) => {
          const trimmedInput = input.trim();
          if (!trimmedInput) return 'Preset name cannot be empty.';
          if (this.config.backupPresets?.some((p) => p.name === trimmedInput)) {
            return 'A backup preset with this name already exists.';
          }
          return true;
        },
      },
      {
        type: 'input',
        name: 'description',
        message: 'Enter preset description (optional):',
      },
    ]);

    const { sourceIndex } = await inquirer.prompt({
      type: 'list',
      name: 'sourceIndex',
      message: 'Select source connection for this preset:',
      choices: this.config.connections.map((conn, index) => ({
        name: `${conn.name} (${conn.database})`,
        value: index,
      })),
    });

    const source = this.config.connections[sourceIndex];

    const { selectionMode } = await inquirer.prompt({
      type: 'list',
      name: 'selectionMode',
      message: 'Select collection selection mode for this preset:',
      choices: [
        { name: 'All collections', value: 'all' },
        { name: 'Include only specified collections', value: 'include' },
        { name: 'Exclude specified collections', value: 'exclude' },
      ],
    });

    let collections: string[] = [];

    if (selectionMode !== 'all') {
      try {
        console.log(`Connecting to ${source.name} to fetch collection list...`);
        const mongoService = new MongoDBService(this.config);
        await mongoService.connect(source);
        const allCollections = await mongoService.getCollections(source.database);
        await mongoService.close();
        console.log(`[${source.name}] Connection closed.`);

        if (allCollections.length === 0) {
          console.log(
            `No collections found in ${source.database}. Preset will affect no collections if mode is include/exclude.`,
          );
        } else {
          const { selectedCollections: presetSelected } = await inquirer.prompt({
            type: 'checkbox',
            name: 'selectedCollections',
            message: `Select collections to ${selectionMode === 'include' ? 'INCLUDE' : 'EXCLUDE'} for this preset:`,
            choices: allCollections.map((coll) => ({ name: coll, value: coll, checked: false })),
            validate: (answer) => {
              if (selectionMode === 'include' && answer.length === 0) {
                return 'Please select at least one collection to include.';
              }
              return true;
            },
          });
          collections = presetSelected;
        }
      } catch (error: any) {
        console.error(`Error getting collection list: ${error.message}`);
        const { manualCollections } = await inquirer.prompt({
          type: 'input',
          name: 'manualCollections',
          message: `Could not fetch collections. Enter collection names separated by comma to ${selectionMode === 'include' ? 'INCLUDE' : 'EXCLUDE'}:`,
          validate: (input: string) => {
            if (selectionMode === 'include' && !input.trim()) {
              return 'Please enter at least one collection to include.';
            }
            return true;
          },
        });
        collections = manualCollections ? manualCollections.split(',').map((c: string) => c.trim()) : [];
      }
    }

    console.log('\n--- Preset Configuration Summary ---');
    console.log(`Name: ${name.trim()}`);
    console.log(`Source: ${source.name} (${source.database})`);
    console.log(`Mode: ${selectionMode}`);
    if (selectionMode === 'include') {
      console.log(
        `Included Collections: ${collections.length > 0 ? collections.join(', ') : '(None selected - backup will be empty!)'}`,
      );
    } else if (selectionMode === 'exclude') {
      console.log(
        `Excluded Collections: ${collections.length > 0 ? collections.join(', ') : '(None - all collections will be backed up)'}`,
      );
    }
    console.log('----------------------------------\n');

    return {
      name: name.trim(),
      description: description.trim() || undefined,
      sourceName: source.name,
      selectionMode,
      collections: selectionMode !== 'all' && collections.length > 0 ? collections : undefined,
      createdAt: new Date().toISOString(),
    };
  }

  async managePresets(): Promise<{ type: 'backup'; preset: BackupPreset } | undefined> {
    const backupPresets = this.config.backupPresets || [];

    if (backupPresets.length === 0) {
      console.log('No saved presets found. Please create a preset first.');
      return undefined;
    }

    const choices = [
      ...backupPresets.map((preset) => ({
        name: `[Backup] ${preset.name}${preset.description ? ` - ${preset.description}` : ''}`,
        value: { type: 'backup', preset },
      })),
      new inquirer.Separator(),
      { name: 'Cancel', value: null },
    ];

    const { selected } = await inquirer.prompt<{ selected: { type: 'backup'; preset: BackupPreset } | null }>({
      type: 'list',
      name: 'selected',
      message: 'Select a preset to manage:',
      choices: choices,
      loop: false,
    });

    if (!selected) {
      console.log('Preset management cancelled.');
      return undefined;
    }

    const { action } = await inquirer.prompt({
      type: 'list',
      name: 'action',
      message: `Action for preset "${selected.preset.name}":`,
      choices: [
        { name: 'Use Preset Now', value: 'use' },
        { name: 'View Details', value: 'view' },
        { name: 'Delete Preset', value: 'delete' },
        { name: 'Cancel', value: 'cancel' },
      ],
    });

    switch (action) {
      case 'use':
        return selected;
      case 'view':
        console.log('\n--- Preset Details ---');
        console.log(JSON.stringify(selected.preset, null, 2));
        console.log('----------------------\n');
        return undefined;
      case 'delete':
        const { confirmDelete } = await inquirer.prompt({
          type: 'confirm',
          name: 'confirmDelete',
          message: `Are you sure you want to permanently delete the preset "${selected.preset.name}"?`,
          default: false,
        });

        if (confirmDelete) {
          if (selected.type === 'backup') {
            this.config.backupPresets = this.config.backupPresets?.filter((p) => p.name !== selected.preset.name);
          }

          try {
            savePresets(this.config);
            console.log(`Preset "${selected.preset.name}" deleted successfully.`);
          } catch (saveError: any) {
            console.error(`Error saving configuration after deleting preset: ${saveError.message}`);
          }
        } else {
          console.log('Preset deletion cancelled.');
        }
        return undefined;
      case 'cancel':
      default:
        console.log('Action cancelled.');
        return undefined;
    }
  }
}
