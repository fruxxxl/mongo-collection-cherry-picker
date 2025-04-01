import inquirer from 'inquirer';
import { loadConfig } from '../utils';

import { CommandLineArgs } from '../types/index';
import { BackupManager } from './backup-manager';
import { RestoreManager } from './restore-manager';
import { PresetManager } from './preset-manager';

export class MongoDBApp {
  private backupManager: BackupManager;
  private restoreManager: RestoreManager;
  private presetManager: PresetManager;
  private args: CommandLineArgs;
  private interactive: boolean;

  constructor(args: CommandLineArgs) {
    this.args = args;
    loadConfig(args.configPath);

    const config = loadConfig();
    this.backupManager = new BackupManager(config);
    this.restoreManager = new RestoreManager(config);
    this.presetManager = new PresetManager(config, this.backupManager, this.restoreManager);

    this.interactive = args.interactive || false;
  }

  async run(): Promise<void> {
    // Non-interactive mode
    if (!this.args.interactive && this.args.mode) {
      await this.runNonInteractiveMode();
      return;
    }

    // Interactive mode
    await this.runInteractiveMode();
  }

  private async runNonInteractiveMode(): Promise<void> {
    console.log(`Running in non-interactive mode: ${this.args.mode}`);

    if (this.args.mode === 'backup' && this.args.source) {
      const backupMode = this.args.backupMode || 'all';
      const collections = this.args.collections || [];
      await this.backupManager.runBackup(this.args.source, backupMode, collections);
      return;
    }

    if (this.args.mode === 'restore' && this.args.backupFile && this.args.target) {
      await this.restoreManager.runRestore(this.args.backupFile, this.args.target, {
        drop: this.args.drop || false,
      });
      return;
    }

    console.log('Insufficient parameters for non-interactive mode');
  }

  private async runInteractiveMode(): Promise<void> {
    const { action } = await inquirer.prompt({
      type: 'list',
      name: 'action',
      message: 'Select action',
      choices: [
        { name: 'Create backup', value: 'backup' },
        { name: 'Restore from backup', value: 'restore' },
        { name: 'Create backup preset', value: 'preset_backup' },
        { name: 'Manage presets', value: 'manage_presets' },
      ],
    });

    switch (action) {
      case 'backup':
        await this.backupManager.backupDatabase();
        break;
      case 'restore':
        await this.restoreFromBackup();
        break;
      case 'preset_backup':
        await this.presetManager.createBackupPreset();
        break;
      case 'manage_presets':
        await this.presetManager.managePresets();
        break;
    }
  }

  private async restoreFromBackup(): Promise<void> {
    try {
      await this.restoreManager.restoreDatabase();

      if (this.interactive) {
        await this.showMainMenu();
      } else {
        setTimeout(() => process.exit(0), 500);
      }
    } catch (error) {
      console.error('Error during restore:', error);

      if (this.interactive) {
        await this.showMainMenu();
      } else {
        setTimeout(() => process.exit(1), 500);
      }
    }
  }

  private async showMainMenu(): Promise<void> {
    await this.runInteractiveMode();
  }
}
