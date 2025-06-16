import type { BackupPreset } from '@ts-types/mixed';

import { Logger } from '@infrastructure/logger';
import { UpdateableConfig } from '@config/updateable-config';
import { PromptService } from '../services/prompt-service';

/**
 * Manages backup presets: creation, listing, deletion, and execution.
 */
export class PresetController {
  constructor(
    private readonly config: UpdateableConfig,
    private readonly promptService: PromptService,
    private readonly logger: Logger,
  ) {}

  /**
   * Main flow for managing presets.
   */
  public async managePresetsFlow(): Promise<BackupPreset | undefined> {
    let preset: BackupPreset | undefined;

    while (true) {
      const action = await this.promptService.askPresetAction();
      if (!action) break;

      switch (action.type) {
        case 'backup':
          preset = action.preset;
          return preset;
        case 'view':
          this.logger.info('--- Preset details ---');
          this.logger.info(JSON.stringify(action.preset, null, 2));
          this.logger.info('----------------------');
          break;
        case 'delete':
          if (await this.promptService.askConfirmDeletePreset(action.preset)) {
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
  public async createPresetInteractively(): Promise<BackupPreset | undefined> {
    let preset: BackupPreset | undefined;

    try {
      preset = await this.promptService.askPresetDetails();
      if (this.isPresetNameDuplicate(preset.name)) {
        this.logger.warn(`Preset with name "${preset.name}" already exists.`);
        return;
      }
      this.addPreset(preset);
      await this.saveConfig();
      this.logger.succeedSpinner(`Preset "${preset.name}" created!`);
    } catch (error: any) {
      this.logger.failSpinner(`Error creating preset: ${error.message}`);
    }

    return preset;
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
}
