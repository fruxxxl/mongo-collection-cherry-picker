import inquirer from 'inquirer';
import { savePresets } from '../utils';
import { PromptService } from './prompt-service';
import { BackupManager } from './backup-manager';
import { AppConfig, BackupPreset } from '../types/index';

/**
 * Manages backup presets: creation, listing, deletion, and execution.
 */
export class PresetManager {
  private config: AppConfig;
  private promptService: PromptService;
  private backupManager: BackupManager;

  /**
   * Creates an instance of PresetManager.
   * @param config - The application configuration.
   * @param backupManager - Manager to execute backups (used for 'Use Preset Now').
   */
  constructor(config: AppConfig, backupManager: BackupManager) {
    this.config = config;
    this.promptService = new PromptService(config);
    this.backupManager = backupManager;
    this.config.backupPresets = this.config.backupPresets || [];
  }

  /**
   * Guides the user through creating a new backup preset interactively.
   * Saves the new preset to the configuration file.
   * Optionally runs the newly created preset immediately.
   */
  async createBackupPreset(): Promise<void> {
    console.log('\n--- Create New Backup Preset ---');
    try {
      const newPreset = await this.promptService.promptForPreset();

      // Check for duplicate name
      if (this.config.backupPresets?.some((p) => p.name === newPreset.name)) {
        console.warn(
          `Warning: A preset with the name "${newPreset.name}" already exists. Overwriting is not supported via creation. Please edit or delete the existing preset.`,
        );
        return;
      }

      this.config.backupPresets = this.config.backupPresets || [];
      this.config.backupPresets.push(newPreset);
      savePresets(this.config);
      console.log(`\n✔ Backup preset "${newPreset.name}" created successfully!`);

      // Ask if the user wants to run the new preset right away
      const { useNow } = await inquirer.prompt({
        type: 'confirm',
        name: 'useNow',
        message: 'Do you want to run this new backup preset now?',
        default: true,
      });

      if (useNow) {
        // Use the BackupManager to execute the preset
        await this.backupManager.useBackupPreset(newPreset);
      }
    } catch (error: any) {
      console.error(`\n✖ Error creating backup preset: ${error.message}`);
    }
  }

  /**
   * Interactively manages existing presets (Use, View, Delete).
   * Fetches the list of presets and prompts the user for actions.
   */
  async managePresets(): Promise<void> {
    console.log('\n--- Manage Existing Presets ---');
    try {
      // Use prompt service to handle preset selection and action
      const selection = await this.promptService.managePresets();

      // If a preset was selected and the action was 'use'
      if (selection && selection.type === 'backup') {
        // Currently only handles backup presets
        console.log(`\nProceeding to use selected preset: "${selection.preset.name}"`);
        // Use the BackupManager to execute the selected preset
        await this.backupManager.useBackupPreset(selection.preset);
      } else {
        // User cancelled, viewed details, or deleted a preset (handled within promptService/managePresets)
        console.log('\nReturning to main menu or exiting.');
      }
    } catch (error: any) {
      console.error(`\n✖ Error managing presets: ${error.message}`);
    }
  }

  /**
   * Retrieves all backup presets.
   * @returns An array of backup presets.
   */
  getBackupPresets(): BackupPreset[] {
    return this.config.backupPresets || [];
  }
}
