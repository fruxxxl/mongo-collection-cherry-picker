import { CommandLineArgs } from '../types';
import { parseISO, subDays, subHours, isValid, subWeeks, subMonths, subYears } from 'date-fns'; // Import date-fns

import { AppConfig } from '../types';

import { loadConfig, parseCommandLineArgs } from '../utils';
import { BackupManager } from '../controllers/backup-manager';
import { RestoreManager } from '../controllers/restore-manager';
import { BackupService } from '../services/backup.service';
import { Logger } from '../utils/logger';
import { RestoreService } from '../services/restore.service';
import { MongoDBService } from '../services/mongodb.service';
import { PromptService } from '../services/prompt-service';

export class CLIModule {
  private args: CommandLineArgs;
  private config: AppConfig;
  private promptService: PromptService;
  private backupManager: BackupManager;
  private restoreManager: RestoreManager;

  constructor(configPath: string) {
    this.args = parseCommandLineArgs();
    this.config = loadConfig(configPath);

    const backupService = new BackupService(this.config, new Logger({ prefix: 'BackupService' }));
    const mongoService = new MongoDBService(this.config, new Logger({ prefix: 'MongoDBService' }));
    const restoreService = new RestoreService(this.config, new Logger({ prefix: 'RestoreService' }));

    this.promptService = new PromptService(
      this.config,
      backupService,
      mongoService,
      new Logger({ prefix: 'PromptService' }),
    );

    this.backupManager = new BackupManager(
      this.config,
      this.promptService,
      mongoService,
      backupService,
      new Logger({ prefix: 'BackupManager' }),
    );

    this.restoreManager = new RestoreManager(
      this.config,
      backupService,
      this.promptService,
      restoreService,
      new Logger({ prefix: 'RestoreManager' }),
    );
  }

  async run(): Promise<void> {
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
}
