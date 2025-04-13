import inquirer from 'inquirer';
import type { ConnectionConfig, BackupMetadata, BackupPreset } from '../types';
import { BackupService } from './backup.service';
import { MongoDBService } from './mongodb.service';
import { subDays, parseISO, isValid, subHours, subWeeks, subMonths, formatISO, format } from 'date-fns';
import { Logger } from '../utils/logger';
import { UpdateableConfig } from '../utils/updateable-config';

/**
 * Provides services for interacting with the user via command-line prompts (inquirer).
 */
export class PromptService {
  constructor(
    private readonly config: UpdateableConfig,
    private readonly backupService: BackupService,
    private readonly mongoService: MongoDBService,
    private readonly logger: Logger,
  ) {}

  async askForStartAction(): Promise<'backup' | 'restore' | 'preset_create' | 'preset_manage' | 'exit'> {
    const { action } = await inquirer.prompt<{
      action: 'backup' | 'restore' | 'preset_create' | 'preset_manage' | 'exit';
    }>({
      type: 'list',
      name: 'action',
      message: 'Select action:',
      choices: [
        { name: 'Create Backup', value: 'backup' },
        { name: 'Restore from Backup', value: 'restore' },
        { name: 'Create Backup Preset', value: 'preset_create' },
        { name: 'Manage Presets (Use/View/Delete)', value: 'preset_manage' },
        new inquirer.Separator(),
        { name: 'Exit', value: 'exit' },
      ],
      loop: false,
    });

    return action;
  }

  async askForContinueAction(): Promise<boolean> {
    const { continueAction } = await inquirer.prompt({
      type: 'confirm',
      name: 'continueAction',
      message: 'Do you want to perform another action?',
      default: true,
    });
    return continueAction;
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
    if (!this.config.parsed.connections || this.config.parsed.connections.length === 0) {
      throw new Error('No connections found in the configuration.');
    }

    const { sourceName } = await inquirer.prompt<{ sourceName: string }>([
      {
        type: 'list',
        name: 'sourceName',
        message: 'Select source connection for backup:',
        choices: this.config.parsed.connections.map((conn) => conn.name),
      },
    ]);
    const source = this.config.parsed.connections.find((conn) => conn.name === sourceName);

    if (!source) {
      throw new Error(`Source connection "${sourceName}" not found in the configuration.`);
    }

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

    let selectedCollections: string[] = [];
    let excludedCollections: string[] = [];
    let startTime: Date | undefined = undefined;

    if (selectionMode === 'include' || selectionMode === 'exclude') {
      let collections: string[] = [];
      this.logger.startSpinner(`Fetching collections from ${source.name}...\n`);
      try {
        await this.mongoService.connect(source);
        collections = await this.mongoService.getCollections(source.database);
        await this.mongoService.close();
        this.logger.succeedSpinner(`Fetched ${collections.length} collections from ${source.name}.`);

        if (collections.length === 0) {
          return { source, selectedCollections: [], excludedCollections: [], selectionMode: 'all', startTime };
        }

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
            startTime = await this.promptForTimeFilter();
          } else if (selectedCollections.length > 1) {
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
      } catch (error: any) {
        this.logger.failSpinner(`Error fetching collections: ${error.message}`);
        throw error;
      }
    }

    return { source, selectedCollections, excludedCollections, selectionMode, startTime };
  }

  /**
   * Helper function to prompt for the time filter choice.
   * @param defaultValue - Optional default date to pre-fill the custom input.
   * @returns The selected start time Date object, or undefined if no filter is chosen.
   */
  private async promptForTimeFilter(defaultValue?: Date): Promise<Date | undefined> {
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
      },
    ]);

    const now = new Date();
    let startTime: Date | undefined = undefined;

    switch (timeFilterChoice) {
      case 'none':
        startTime = undefined;
        break;
      case '1h':
        startTime = subHours(now, 1);
        break;
      case '6h':
        startTime = subHours(now, 6);
        break;
      case '12h':
        startTime = subHours(now, 12);
        break;
      case '1d':
        startTime = subDays(now, 1);
        break;
      case '3d':
        startTime = subDays(now, 3);
        break;
      case '1w':
        startTime = subWeeks(now, 1);
        break;
      case '1M':
        startTime = subMonths(now, 1);
        break;
      case 'custom':
        const { customDate } = await inquirer.prompt<{ customDate: string }>([
          {
            type: 'input',
            name: 'customDate',
            message: 'Enter custom start date/time (YYYY-MM-DD HH:mm:ss or ISO format):',
            default: defaultValue ? format(defaultValue, 'yyyy-MM-dd HH:mm:ss') : undefined,
            validate: (input: string) => {
              const parsed = parseISO(input);
              if (isValid(parsed)) return true;
              const customParsed = parseISO(input.replace(' ', 'T'));
              if (isValid(customParsed)) return true;
              return 'Invalid date/time format. Use YYYY-MM-DD HH:mm:ss or ISO 8601.';
            },
            filter: (input: string) => input.trim(),
          },
        ]);
        startTime = parseISO(customDate.includes('T') ? customDate : customDate.replace(' ', 'T'));
        break;
      default:
        startTime = undefined;
    }

    if (startTime && isValid(startTime)) {
      return startTime;
    } else if (timeFilterChoice !== 'none') {
    }
    return undefined;
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
      this.logger.info('--- Selected Backup Metadata ---');
      this.logger.info(`Source Connection: ${backupMetadata.source}`);
      this.logger.info(`Database:          ${backupMetadata.database || 'N/A (Older Backup?)'}`);
      this.logger.info(`Created At:        ${new Date(backupMetadata.timestamp).toLocaleString()}`);
      this.logger.info(`Selection Mode:    ${backupMetadata.selectionMode}`);
      if (
        backupMetadata.selectionMode === 'include' &&
        Array.isArray(backupMetadata.includedCollections) &&
        backupMetadata.includedCollections.length > 0
      ) {
        this.logger.info(`Included Collections: ${backupMetadata.includedCollections.join(', ')}`);
      } else if (
        backupMetadata.selectionMode === 'exclude' &&
        Array.isArray(backupMetadata.excludedCollections) &&
        backupMetadata.excludedCollections.length > 0
      ) {
        this.logger.info(`Excluded Collections: ${backupMetadata.excludedCollections.join(', ')}`);
      }
      this.logger.info('------------------------------');
    } catch (error: any) {
      this.logger.error(`Error loading metadata for ${backupFile}: ${error.message}`);
      throw new Error(`Failed to load metadata for selected backup: ${error.message}`);
    }

    const { target } = await inquirer.prompt({
      type: 'list',
      name: 'target',
      message: 'Select target connection for restore:',
      choices: this.config.parsed.connections.map((conn) => ({
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
      ? this.config.parsed.connections.filter((conn) => conn.name !== excludeSource.name)
      : this.config.parsed.connections;

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
          if (this.config.parsed.backupPresets?.some((p) => p.name === trimmedInput)) {
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
      choices: this.config.parsed.connections.map((conn, index) => ({
        name: `${conn.name} (${conn.database})`,
        value: index,
      })),
    });

    const source = this.config.parsed.connections[sourceIndex];

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
        await this.mongoService.connect(source);
        const allCollections = await this.mongoService.getCollections(source.database);
        await this.mongoService.close();

        if (allCollections.length === 0) {
          this.logger.info(
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
        this.logger.error(`Error getting collection list: ${error.message}`);
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

    this.logger.info('--- Preset Configuration Summary ---');
    this.logger.info(`Name: ${name.trim()}`);
    this.logger.info(`Source: ${source.name} (${source.database})`);
    this.logger.info(`Mode: ${selectionMode}`);
    if (selectionMode === 'include') {
      this.logger.info(
        `Included Collections: ${collections.length > 0 ? collections.join(', ') : '(None selected - backup will be empty!)'}`,
      );
    } else if (selectionMode === 'exclude') {
      this.logger.info(
        `Excluded Collections: ${collections.length > 0 ? collections.join(', ') : '(None - all collections will be backed up)'}`,
      );
    }
    this.logger.info('----------------------------------');

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
    const backupPresets = this.config.parsed.backupPresets || [];

    if (backupPresets.length === 0) {
      this.logger.info('No saved presets found. Please create a preset first.');
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
      this.logger.info('Preset management cancelled.');
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
        this.logger.info('--- Preset Details ---');
        this.logger.info(JSON.stringify(selected.preset, null, 2));
        this.logger.info('----------------------');
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
            this.config.parsed.backupPresets = this.config.parsed.backupPresets?.filter(
              (p) => p.name !== selected.preset.name,
            );
          }

          try {
            this.config.update(this.config.parsed);
            this.logger.info(`Preset "${selected.preset.name}" deleted successfully.`);
          } catch (saveError: any) {
            this.logger.error(`Error saving configuration after deleting preset: ${saveError.message}`);
          }
        } else {
          this.logger.info('Preset deletion cancelled.');
        }
        return undefined;
      case 'cancel':
      default:
        this.logger.info('Action cancelled.');
        return undefined;
    }
  }

  /**
   * Prompts the user for details needed to create or update a backup preset.
   * @param existingPreset - Optional existing preset data for editing.
   * @returns A promise that resolves with the new or updated preset configuration.
   */
  async promptForPreset(existingPreset?: BackupPreset): Promise<BackupPreset> {
    this.logger.info(existingPreset ? '--- Editing Backup Preset ---' : '--- Creating New Backup Preset ---');

    const nameAnswer = await inquirer.prompt<{ name: string }>([
      {
        type: 'input',
        name: 'name',
        message: 'Preset name:',
        default: existingPreset?.name,
        validate: (input: string) => (input.trim() ? true : 'Preset name cannot be empty.'),
      },
    ]);
    const name = nameAnswer.name.trim();

    const sourceChoices = this.config.parsed.connections.map((c) => ({
      name: `${c.name} (${c.database})`,
      value: c,
    }));
    const sourceAnswer = await inquirer.prompt<{ source: ConnectionConfig }>([
      {
        type: 'list',
        name: 'source',
        message: 'Select source connection:',
        choices: sourceChoices,
        default: sourceChoices.findIndex((c) => c.value.name === existingPreset?.sourceName),
      },
    ]);
    const source = sourceAnswer.source;

    const modeAnswer = await inquirer.prompt<{ selectionMode: 'all' | 'include' | 'exclude' }>([
      {
        type: 'list',
        name: 'selectionMode',
        message: 'Select collection mode:',
        choices: ['all', 'include', 'exclude'],
        default: existingPreset?.selectionMode || 'all',
      },
    ]);
    const selectionMode = modeAnswer.selectionMode;

    let collections: string[] = existingPreset?.collections || [];
    let queryStartTime: string | undefined = existingPreset?.queryStartTime;

    if (selectionMode === 'include' || selectionMode === 'exclude') {
      this.logger.startSpinner(`Fetching collections from ${source.name}...\n`);
      try {
        await this.mongoService.connect(source);
        const allCollections = await this.mongoService.getCollections(source.database);
        this.logger.succeedSpinner(`Fetched ${allCollections.length} collections from ${source.name}.`);

        const collectionAnswer = await inquirer.prompt<{ collections: string[] }>([
          {
            type: 'checkbox',
            name: 'collections',
            message: `Select collections to ${selectionMode === 'include' ? 'INCLUDE' : 'EXCLUDE'}:`,
            choices: allCollections,
            default: collections,
            validate: (answer: string[]) => {
              if (selectionMode === 'include' && answer.length === 0) {
                return 'Please select at least one collection to include.';
              }
              return true;
            },
          },
        ]);
        collections = collectionAnswer.collections;

        if (selectionMode === 'include') {
          if (collections.length === 1) {
            this.logger.info('--- Time Filter (Optional) ---');
            this.logger.info('Applies only when using this preset.');
            const applyTimeFilterAnswer = await inquirer.prompt<{ apply: boolean }>([
              {
                type: 'confirm',
                name: 'apply',
                message: `Apply time filter to collection "${collections[0]}"? (Backup documents created/updated after a specific time)`,
                default: !!queryStartTime,
              },
            ]);

            if (applyTimeFilterAnswer.apply) {
              const startTimeDate = await this.promptForTimeFilter(
                queryStartTime ? parseISO(queryStartTime) : undefined,
              );
              queryStartTime = startTimeDate ? formatISO(startTimeDate) : undefined;
              if (queryStartTime) {
                this.logger.info(`Time filter set to: >= ${queryStartTime}`);
              } else {
                this.logger.info('No time filter applied.');
              }
            } else {
              queryStartTime = undefined;
              this.logger.info('No time filter applied.');
            }
          } else if (queryStartTime) {
            this.logger.info('Info: Time filter cleared because more/less than one collection is selected.');
            queryStartTime = undefined;
          }
        }
      } catch (error: any) {
        this.logger.failSpinner(`Error fetching collections: ${error.message}`);
        const { manualCollections } = await inquirer.prompt({
          type: 'input',
          name: 'manualCollections',
          message: `Could not fetch collections. Enter collection names separated by comma to ${selectionMode === 'include' ? 'INCLUDE' : 'EXCLUDE'}:`,
          default: collections.join(','),
          validate: (input: string) => {
            if (selectionMode === 'include' && !input.trim()) {
              return 'Please enter at least one collection to include.';
            }
            return true;
          },
        });
        collections = manualCollections ? manualCollections.split(',').map((c: string) => c.trim()) : [];
      } finally {
        if (this.mongoService.getClient()) {
          await this.mongoService.close();
        }
      }
    } else {
      collections = [];
      if (queryStartTime) {
        this.logger.info('Info: Time filter cleared because mode is not "include".');
        queryStartTime = undefined;
      }
    }

    this.logger.info('--- Preset Configuration Summary ---');
    this.logger.info(`Name: ${name}`);
    this.logger.info(`Source: ${source.name} (${source.database})`);
    this.logger.info(`Mode: ${selectionMode}`);
    if (selectionMode !== 'all') {
      this.logger.info(`Collections: ${collections.length > 0 ? collections.join(', ') : '(none)'}`);
    }
    if (queryStartTime) {
      this.logger.info(`Time Filter: >= ${queryStartTime}`);
    }

    return {
      name,
      sourceName: source.name,
      selectionMode,
      collections,
      createdAt: existingPreset?.createdAt || formatISO(new Date()),
      queryStartTime,
    };
  }
}
