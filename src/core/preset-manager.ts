import inquirer from 'inquirer';
import { savePresets } from '../utils';
import { PromptService } from '../utils/prompts';
import { BackupManager } from './backup-manager';
import { RestoreManager } from './restore-manager';
import { AppConfig } from '../types/index';

/**
 * Manages backup presets: creation, listing, deletion, and execution.
 */
export class PresetManager {
  private config: AppConfig;
  private promptService: PromptService;
  private backupManager: BackupManager;
  private restoreManager: RestoreManager;

  /**
   * Creates an instance of PresetManager.
   * @param config - The application configuration.
   * @param backupManager - Manager to execute backups (used for 'Use Preset Now').
   * @param restoreManager - Manager for restoring from backups.
   */
  constructor(config: AppConfig, backupManager: BackupManager, restoreManager: RestoreManager) {
    this.config = config;
    this.promptService = new PromptService(config);
    this.backupManager = backupManager;
    this.restoreManager = restoreManager;
  }

  /**
   * Guides the user through creating a new backup preset interactively.
   * Saves the new preset to the configuration file.
   * Optionally runs the newly created preset immediately.
   */
  async createBackupPreset(): Promise<void> {
    console.log('\n--- Create New Backup Preset ---');
    try {
      // Prompt user for preset details
      const newPreset = await this.promptService.promptForBackupPreset();

      // Initialize presets array if it doesn't exist or is null
      if (!Array.isArray(this.config.backupPresets)) {
        this.config.backupPresets = [];
      }

      // Add the new preset to the configuration object
      this.config.backupPresets.push(newPreset);

      // Save the updated configuration back to the file
      savePresets(this.config); // Assumes configPath is handled by savePresets or uses default

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
      // Catch errors during preset creation or saving
      console.error(`\n✖ Error creating preset: ${error.message}`);
      // Log the error, but don't necessarily stop the application unless critical
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
}
