import inquirer from 'inquirer';
import { PromptService } from '../services/prompt-service';
import { BackupController } from './backup-controller';
import { Logger } from '../utils/logger';
import { UpdateableConfig } from '../utils/updateable-config';

/**
 * Manages backup presets: creation, listing, deletion, and execution.
 */
export class PresetController {
  constructor(
    private readonly config: UpdateableConfig,
    private readonly backupController: BackupController,
    private readonly promptService: PromptService,
    private readonly logger: Logger,
  ) {}

  public async managePresetsFlow(): Promise<void> {
    const selectedPresetAction = await this.promptService.managePresets();
    if (selectedPresetAction?.type === 'backup') {
      await this.backupController.useBackupPreset(selectedPresetAction.preset);
    }
  }

  /**
   * Guides the user through creating a new backup preset interactively.
   * Saves the new preset to the configuration file.
   * Optionally runs the newly created preset immediately.
   */
  async createBackupPreset(): Promise<void> {
    try {
      const newPreset = await this.promptService.promptForPreset();

      // Check for duplicate name
      if (this.config.parsed.backupPresets?.some((p) => p.name === newPreset.name)) {
        this.logger.warn(
          `Warning: A preset with the name "${newPreset.name}" already exists. Overwriting is not supported via creation. Please edit or delete the existing preset.`,
        );
        return;
      }

      this.config.parsed.backupPresets.push(newPreset);
      this.config.update(this.config.parsed);
      this.logger.succeedSpinner(`Backup preset "${newPreset.name}" created successfully!`);

      // Ask if the user wants to run the new preset right away
      const { useNow } = await inquirer.prompt({
        type: 'confirm',
        name: 'useNow',
        message: 'Do you want to run this new backup preset now?',
        default: true,
      });

      if (useNow) {
        // Use the backupController to execute the preset
        await this.backupController.useBackupPreset(newPreset);
      }
    } catch (error: any) {
      this.logger.failSpinner(`Error creating backup preset: ${error.message}`);
    }
  }

  /**
   * Interactively manages existing presets (Use, View, Delete).
   * Fetches the list of presets and prompts the user for actions.
   */
  async managePresets(): Promise<void> {
    this.logger.info('--- Manage Existing Presets ---');
    try {
      // Use prompt service to handle preset selection and action
      const selection = await this.promptService.managePresets();

      // If a preset was selected and the action was 'use'
      if (selection && selection.type === 'backup') {
        // Currently only handles backup presets
        this.logger.info(`Proceeding to use selected preset: "${selection.preset.name}"`);
        // Use the backupController to execute the selected preset
        await this.backupController.useBackupPreset(selection.preset);
      } else {
        // User cancelled, viewed details, or deleted a preset (handled within promptService/managePresets)
        this.logger.info('Returning to main menu or exiting.');
      }
    } catch (error: any) {
      this.logger.failSpinner(`Error managing presets: ${error.message}`);
    }
  }
}
