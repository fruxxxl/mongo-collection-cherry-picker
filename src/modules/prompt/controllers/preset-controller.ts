import inquirer from 'inquirer';
import { PromptService } from '../services/prompt-service';

import { Logger } from '@infrastructure/logger';
import { UpdateableConfig } from '@config/updateable-config';
import { BackupController } from '@modules/backup/controllers/backup-controller';
import type { BackupPreset } from '@ts-types/mixed';

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

  /**
   * Main flow for managing presets.
   */
  public async managePresetsFlow(): Promise<void> {
    while (true) {
      const action = await this.promptService.promptPresetAction();
      if (!action) break;

      switch (action.type) {
        case 'backup':
          await this.runPreset(action.preset);
          break;
        case 'view':
          this.logger.info('--- Preset details ---');
          this.logger.info(JSON.stringify(action.preset, null, 2));
          this.logger.info('----------------------');
          break;
        case 'delete':
          if (await this.confirmDeletePreset(action.preset)) {
            this.removePreset(action.preset.name);
            await this.saveConfig();
            this.logger.info(`Preset "${action.preset.name}" deleted.`);
          } else {
            this.logger.info('Deletion cancelled.');
          }
          break;
      }
    }
  }

  /**
   * Interactive preset creation and (optionally) running.
   */
  public async createPresetInteractively(): Promise<void> {
    try {
      const newPreset = await this.promptService.promptForPreset();
      if (this.isPresetNameDuplicate(newPreset.name)) {
        this.logger.warn(`Preset with name "${newPreset.name}" already exists.`);
        return;
      }
      this.addPreset(newPreset);
      await this.saveConfig();
      this.logger.succeedSpinner(`Preset "${newPreset.name}" created!`);
      if (await this.promptService.confirmRunPresetNow()) {
        await this.runPreset(newPreset);
      }
    } catch (error: any) {
      this.logger.failSpinner(`Error creating preset: ${error.message}`);
    }
  }

  // --- Private methods ---

  private isPresetNameDuplicate(name: string): boolean {
    return this.config.parsed.backupPresets?.some((p) => p.name === name) ?? false;
  }

  private addPreset(preset: BackupPreset): void {
    this.config.parsed.backupPresets.push(preset);
  }

  private removePreset(name: string): void {
    this.config.parsed.backupPresets = this.config.parsed.backupPresets.filter((p) => p.name !== name);
  }

  private async saveConfig(): Promise<void> {
    this.config.update(this.config.parsed);
  }

  private async runPreset(preset: BackupPreset): Promise<void> {
    await this.backupController.useBackupPreset(preset);
  }

  private async confirmDeletePreset(preset: BackupPreset): Promise<boolean> {
    const { confirmDelete } = await inquirer.prompt({
      type: 'confirm',
      name: 'confirmDelete',
      message: `Delete preset "${preset.name}" without recovery?`,
      default: false,
    });
    return confirmDelete;
  }
}
