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

  constructor(args: CommandLineArgs) {
    this.args = args;
    loadConfig(args.configPath);

    const config = loadConfig();
    this.backupManager = new BackupManager(config);
    this.restoreManager = new RestoreManager(config);
    this.presetManager = new PresetManager(config, this.backupManager, this.restoreManager);
  }

  async run(): Promise<void> {
    // Неинтерактивный режим
    if (!this.args.interactive && this.args.mode) {
      await this.runNonInteractiveMode();
      return;
    }

    // Интерактивный режим
    await this.runInteractiveMode();
  }

  private async runNonInteractiveMode(): Promise<void> {
    console.log(`Запуск в неинтерактивном режиме: ${this.args.mode}`);

    if (this.args.mode === 'backup' && this.args.source) {
      const backupMode = this.args.backupMode || 'all';
      const collections = this.args.collections || [];
      await this.backupManager.runBackup(this.args.source, backupMode, collections);
      return;
    }

    if (this.args.mode === 'restore' && this.args.backupFile && this.args.target) {
      await this.restoreManager.runRestore(this.args.backupFile, this.args.target, []);
      return;
    }

    console.log('Недостаточно параметров для неинтерактивного режима');
  }

  private async runInteractiveMode(): Promise<void> {
    const { action } = await inquirer.prompt({
      type: 'list',
      name: 'action',
      message: 'Выберите действие',
      choices: [
        { name: 'Создать резервную копию', value: 'backup' },
        { name: 'Восстановить из резервной копии', value: 'restore' },
        { name: 'Создать пресет резервной копии', value: 'preset_backup' },
        { name: 'Создать пресет восстановления', value: 'preset_restore' },
        { name: 'Управление пресетами', value: 'manage_presets' }
      ]
    });

    switch (action) {
      case 'backup':
        await this.backupManager.backupDatabase();
        break;
      case 'restore':
        await this.restoreManager.restoreDatabase();
        break;
      case 'preset_backup':
        await this.presetManager.createBackupPreset();
        break;
      case 'preset_restore':
        await this.presetManager.createRestorePreset();
        break;
      case 'manage_presets':
        await this.presetManager.managePresets();
        break;
    }
  }
}
