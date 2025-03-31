import inquirer from 'inquirer';
import { savePresets } from '../utils';
import { PromptService } from '../utils/prompts';
import { BackupManager } from './backup-manager';
import { RestoreManager } from './restore-manager';
import { AppConfig, BackupPreset, RestorePreset } from '../types/index';

export class PresetManager {
  private config: AppConfig;
  private promptService: PromptService;
  private backupManager: BackupManager;
  private restoreManager: RestoreManager;

  constructor(config: AppConfig, backupManager: BackupManager, restoreManager: RestoreManager) {
    this.config = config;
    this.promptService = new PromptService(config);
    this.backupManager = backupManager;
    this.restoreManager = restoreManager;
  }

  async createBackupPreset(): Promise<void> {
    try {
      const preset = await this.promptService.promptForBackupPreset();

      // Initialize presets array if it doesn't exist
      if (!this.config.backupPresets) {
        this.config.backupPresets = [];
      }

      // Add new preset
      this.config.backupPresets.push(preset);

      // Save configuration
      savePresets(this.config);

      console.log(`Backup preset "${preset.name}" successfully created!`);

      // Suggest to use preset immediately
      const { useNow } = await inquirer.prompt({
        type: 'confirm',
        name: 'useNow',
        message: 'Do you want to use this preset right now?',
        default: true
      });

      if (useNow) {
        await this.backupManager.useBackupPreset(preset);
      }
    } catch (error) {
      console.error(
        `Error creating preset: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async managePresets(): Promise<void> {
    // Add debug output
    console.log(`DEBUG: Config contains ${this.config.backupPresets?.length || 0} backup presets`);
    if (this.config.backupPresets) {
      console.log(
        `Backup presets: ${JSON.stringify(this.config.backupPresets.map((p: any) => p.name))}`
      );
    }

    // Check for presets
    const hasBackupPresets = this.config.backupPresets && this.config.backupPresets.length > 0;

    if (!hasBackupPresets) {
      console.log('No saved presets found. Please create a preset first.');
      return;
    }

    try {
      const result = await this.promptService.managePresets();

      if (result) {
        // Using selected preset
        if (result.type === 'backup') {
          await this.backupManager.useBackupPreset(result.preset as BackupPreset);
        } else {
          await this.restoreManager.useRestorePreset(result.preset as RestorePreset);
        }
      }
    } catch (error) {
      console.error(
        `Error managing presets: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
