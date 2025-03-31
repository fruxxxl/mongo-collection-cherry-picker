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

      // Инициализируем массив пресетов, если он не существует
      if (!this.config.backupPresets) {
        this.config.backupPresets = [];
      }

      // Добавляем новый пресет
      this.config.backupPresets.push(preset);

      // Сохраняем конфигурацию
      savePresets(this.config);

      console.log(`Пресет резервного копирования "${preset.name}" успешно создан!`);

      // Предлагаем использовать пресет немедленно
      const { useNow } = await inquirer.prompt({
        type: 'confirm',
        name: 'useNow',
        message: 'Хотите использовать этот пресет прямо сейчас?',
        default: true
      });

      if (useNow) {
        await this.backupManager.useBackupPreset(preset);
      }
    } catch (error) {
      console.error(
        `Ошибка создания пресета: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async createRestorePreset(): Promise<void> {
    try {
      const preset = await this.promptService.promptForRestorePreset();

      // Инициализируем массив пресетов, если он не существует
      if (!this.config.restorePresets) {
        this.config.restorePresets = [];
      }

      // Добавляем новый пресет
      this.config.restorePresets.push(preset);

      // Сохраняем конфигурацию
      savePresets(this.config);

      console.log(`Пресет восстановления "${preset.name}" успешно создан!`);

      // Предлагаем использовать пресет немедленно
      const { useNow } = await inquirer.prompt({
        type: 'confirm',
        name: 'useNow',
        message: 'Хотите использовать этот пресет прямо сейчас?',
        default: true
      });

      if (useNow) {
        await this.restoreManager.useRestorePreset(preset);
      }
    } catch (error) {
      console.error(
        `Ошибка создания пресета: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async managePresets(): Promise<void> {
    // Добавляем отладочный вывод
    console.log(
      `ОТЛАДКА: Конфигурация содержит ${this.config.backupPresets?.length || 0} пресетов резервного копирования и ${this.config.restorePresets?.length || 0} пресетов восстановления`
    );
    if (this.config.backupPresets) {
      console.log(
        `Пресеты резервного копирования: ${JSON.stringify(this.config.backupPresets.map((p: any) => p.name))}`
      );
    }
    if (this.config.restorePresets) {
      console.log(
        `Пресеты восстановления: ${JSON.stringify(this.config.restorePresets.map((p: any) => p.name))}`
      );
    }

    // Проверяем наличие пресетов
    if (
      (!this.config.backupPresets || this.config.backupPresets.length === 0) &&
      (!this.config.restorePresets || this.config.restorePresets.length === 0)
    ) {
      console.log('Не найдено сохраненных пресетов. Пожалуйста, сначала создайте пресет.');
      return;
    }

    try {
      const result = await this.promptService.managePresets();

      if (result) {
        // Используем выбранный пресет
        if (result.type === 'backup') {
          await this.backupManager.useBackupPreset(result.preset as BackupPreset);
        } else {
          await this.restoreManager.useRestorePreset(result.preset as RestorePreset);
        }
      }
    } catch (error) {
      console.error(
        `Ошибка при управлении пресетами: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
