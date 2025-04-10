import inquirer from 'inquirer';
import type { AppConfig, CommandLineArgs } from '../types'; // Use type import
import { loadConfig } from '../utils';
import { BackupManager } from './backup-manager';
import { RestoreManager } from './restore-manager';
import { PresetManager } from './preset-manager';
import { PromptService } from './prompt-service';
import { BackupService } from '../services/backup.service'; // Needed for restore prompt
import { parseISO, subDays, subHours, isValid, subWeeks, subMonths, subYears } from 'date-fns'; // Import date-fns

/**
 * Main application class orchestrating backup, restore, and preset operations.
 * Handles both interactive and non-interactive (command-line argument based) modes.
 */
export class MongoDBApp {
  private config: AppConfig;
  private args: CommandLineArgs;
  private backupManager: BackupManager;
  private restoreManager: RestoreManager;
  private presetManager: PresetManager;
  private promptService: PromptService; // Added for interactive restore

  /**
   * Creates an instance of MongoDBApp.
   * Loads configuration based on provided arguments.
   * Initializes manager and service classes.
   * @param args - Parsed command line arguments.
   */
  constructor(args: CommandLineArgs) {
    this.args = args;
    // Load configuration immediately
    this.config = loadConfig(args.configPath!);
    // Initialize managers and services with loaded config
    const backupService = new BackupService(this.config); // Shared service instance
    this.promptService = new PromptService(this.config); // Pass config
    this.backupManager = new BackupManager(this.config, this.promptService);
    this.restoreManager = new RestoreManager(this.config, backupService, this.promptService); // Pass services
    this.presetManager = new PresetManager(this.config, this.backupManager); // Pass dependencies
  }

  /**
   * Runs the application based on the provided command line arguments.
   * Determines whether to run in interactive or non-interactive mode.
   */
  async run(): Promise<void> {
    if (this.args.interactive) {
      console.log('Running in interactive mode...');
      await this.runInteractiveMode();
    } else {
      console.log('Running in non-interactive mode...');
      await this.runNonInteractiveMode();
    }
  }

  /**
   * Runs the application in interactive mode, prompting the user for actions.
   */
  private async runInteractiveMode(): Promise<void> {
    let exit = false;
    while (!exit) {
      try {
        const { action } = await inquirer.prompt({
          type: 'list',
          name: 'action',
          message: 'Select action:',
          choices: [
            { name: 'Create Backup', value: 'backup' },
            { name: 'Restore from Backup', value: 'restore' },
            { name: 'Create Backup Preset', value: 'preset_create' }, // Renamed for clarity
            { name: 'Manage Presets (Use/View/Delete)', value: 'preset_manage' }, // Renamed for clarity
            new inquirer.Separator(),
            { name: 'Exit', value: 'exit' },
          ],
          loop: false,
        });

        switch (action) {
          case 'backup':
            await this.backupManager.backupDatabase();
            break;
          case 'restore':
            await this.restoreFromBackup(); // Use dedicated method
            break;
          case 'preset_create':
            await this.presetManager.createBackupPreset();
            break;
          case 'preset_manage':
            const selectedPresetAction = await this.promptService.managePresets();
            if (selectedPresetAction?.type === 'backup') {
              await this.backupManager.useBackupPreset(selectedPresetAction.preset);
            }
            break;
          case 'exit':
            exit = true;
            break;
          default:
            console.log('Invalid action selected.');
        }

        if (!exit) {
          const { continueAction } = await inquirer.prompt({
            type: 'confirm',
            name: 'continueAction',
            message: 'Do you want to perform another action?',
            default: true,
          });
          if (!continueAction) {
            exit = true;
          }
        }
      } catch (error: any) {
        console.error(`\n✖ Interactive mode error: ${error.message}`);
        exit = true; // Exit on error
      }
    }
    console.log('Exiting application.');
  }

  /**
   * Runs the application in non-interactive mode based on command line arguments.
   * Executes backup or restore operations directly.
   * @throws An error if required arguments for the specified mode are missing.
   */
  private async runNonInteractiveMode(): Promise<void> {
    switch (this.args.mode) {
      case 'backup':
        await this.backupFromArgs();
        break;
      case 'restore':
        await this.restoreFromArgs();
        break;
      default:
        // If no mode specified in non-interactive, display help or error
        console.error('Error: Operation mode (--backup or --restore) is required in non-interactive mode.');
        console.log('Run with --interactive for guided prompts.');
        process.exit(1); // Exit with error code
    }
  }

  /** Parses the --since-time argument string into a Date object */
  private parseSinceTime(sinceArg: string): Date | undefined {
    // Try parsing as ISO 8601 first
    let date = parseISO(sinceArg);
    if (isValid(date)) {
      console.log(`Parsed --since-time as ISO date: ${date.toISOString()}`);
      return date;
    }

    // Try parsing relative durations (e.g., "1d", "7d", "3h", "1w")
    const durationMatch = sinceArg.match(/^(\d+)([dhwMy])$/i); // Match d, h, w, M, y
    if (durationMatch) {
      const value = parseInt(durationMatch[1], 10);
      const unit = durationMatch[2].toLowerCase();
      const now = new Date();
      try {
        // Wrap date-fns calls in try-catch
        if (unit === 'd') {
          date = subDays(now, value);
        } else if (unit === 'h') {
          date = subHours(now, value);
        } else if (unit === 'w') {
          date = subWeeks(now, value);
        } else if (unit === 'M') {
          date = subMonths(now, value);
        } else if (unit === 'y') {
          date = subYears(now, value);
        }
        if (isValid(date)) {
          console.log(`Parsed --since-time as ${value}${unit} ago: ${date.toISOString()}`);
          return date;
        } else {
          throw new Error('Resulting date is invalid');
        }
      } catch (e) {
        console.error(`Error calculating relative date for ${sinceArg}: ${e}`);
        return undefined;
      }
    }

    console.error(
      `Error: Invalid format for --since-time argument: "${sinceArg}". Use ISO 8601 or relative duration (e.g., "1d", "3h", "2w", "1M").`,
    );
    return undefined; // Indicate parsing failure
  }

  /**
   * Performs a backup operation based on non-interactive arguments.
   * Handles presets or direct source/collection specification.
   * @private
   */
  private async backupFromArgs(): Promise<void> {
    if (this.args.preset) {
      // Find and use the specified preset
      const preset = this.config.backupPresets?.find((p) => p.name === this.args.preset);
      if (!preset) {
        throw new Error(`Backup preset "${this.args.preset}" not found in configuration.`);
      }
      console.log(`Using backup preset: ${preset.name}`);
      await this.backupManager.useBackupPreset(preset);
    } else if (this.args.source) {
      const backupMode = this.args.backupMode || 'all';
      const collections = this.args.collections || [];

      // --- Parse --since-time argument ---
      let startTime: Date | undefined = undefined;
      if (this.args.sinceTime) {
        startTime = this.parseSinceTime(this.args.sinceTime);
        if (!startTime) {
          return; // Stop processing if time format is invalid
        }

        // --- VALIDATION for --since-time ---
        if (backupMode !== 'include') {
          console.error('Error: --since-time can only be used with --backupMode=include.');
          return; // Exit
        }
        if (collections.length !== 1) {
          console.error('Error: --since-time requires exactly one collection specified via --collections.');
          return; // Exit
        }
        console.log(`Validated: --since-time will be applied to collection: ${collections[0]}`);
        // --- End VALIDATION ---
      }
      // --- End Parse --since-time ---

      // Validate mode (basic check, specific validation for since-time done above)
      if (!['all', 'include', 'exclude'].includes(backupMode)) {
        console.error(`Invalid backup mode: ${backupMode}. Must be 'all', 'include', or 'exclude'.`);
        return;
      }
      // Validate collections for include/exclude modes (excluding the since-time case already handled)
      if (!startTime && (backupMode === 'include' || backupMode === 'exclude') && collections.length === 0) {
        if (backupMode === 'include') {
          console.error('Mode "include" requires a list of collections via --collections.');
          return;
        } else {
          console.log('Info: Mode "exclude" with no collections specified; defaulting to backing up all collections.');
        }
      }

      try {
        // Pass arguments to the manager
        await this.backupManager.backupFromArgs(
          this.args.source,
          backupMode as 'all' | 'include' | 'exclude', // Type assertion is okay after validation
          collections,
          startTime, // Pass potentially undefined startTime
        );
      } catch (error: any) {
        console.error('\n✖ Backup command failed.');
      }
    } else {
      console.error('Error: No source specified for backup.');
      process.exit(1);
    }
  }

  /**
   * Performs a restore operation based on non-interactive arguments.
   * @private
   */
  private async restoreFromArgs(): Promise<void> {
    if (!this.args.backupFile) {
      throw new Error('--backupFile (or --file) is required for restore mode.');
    }
    if (!this.args.target) {
      throw new Error('--target connection name is required for restore mode.');
    }

    // Options for restore (currently only 'drop')
    const restoreOptions = {
      drop: this.args.drop || false,
    };

    await this.restoreManager.runRestore(this.args.backupFile, this.args.target, restoreOptions);
  }

  /**
   * Handles the interactive restore workflow using PromptService.
   * @private
   */
  private async restoreFromBackup(): Promise<void> {
    try {
      // Use prompt service to get user input for restore
      const { backupFile, target, options } = await this.promptService.promptForRestore();
      // Run the restore using the collected information
      await this.restoreManager.runRestore(backupFile, target.name, options);
    } catch (error: any) {
      console.error(`\n✖ Restore failed: ${error.message}`);
      // Error is logged, no need to re-throw unless specific handling is needed here
    }
  }
}
