import ora from 'ora';
import path from 'path';
import inquirer from 'inquirer';
import fs from 'fs';
import { MongoDBService } from '../services/mongodb.service';
import { BackupService } from '../services/backup.service';
import { RestoreService } from '../services/restore.service';
import { PromptService } from '../utils/prompts';
import { AppConfig, RestorePreset, ConnectionConfig } from '../types/index';

export class RestoreManager {
  private config: AppConfig;
  private mongoService: MongoDBService;
  private backupService: BackupService;
  private restoreService: RestoreService;
  private promptService: PromptService;

  constructor(config: AppConfig) {
    this.config = config;
    this.mongoService = new MongoDBService(config);
    this.backupService = new BackupService(config);
    this.restoreService = new RestoreService(config);
    this.promptService = new PromptService(config);
  }

  async runRestore(
    backupFile: string,
    targetName: string,
    collections: string[] = []
  ): Promise<void> {
    if (!fs.existsSync(backupFile)) {
      throw new Error(`Файл резервной копии не найден: ${backupFile}`);
    }

    const backupMetadata = this.backupService.loadBackupMetadata(backupFile);

    // Находим целевое подключение
    const targetConfig = this.config.connections.find(
      (conn: ConnectionConfig) => conn.name === targetName
    );
    if (!targetConfig) {
      throw new Error(`Подключение "${targetName}" не найдено в конфигурации`);
    }

    // Если коллекции не указаны, используем все из резервной копии
    const collectionsToRestore = collections.length > 0 ? collections : backupMetadata.collections;

    // Восстановление
    await this.restoreService.restoreBackup(backupMetadata, targetConfig, collectionsToRestore);

    console.log(`Резервная копия успешно восстановлена в базу данных ${targetName}`);
  }

  async restoreDatabase(): Promise<void> {
    // Используем PromptService для интерактивного выбора
    const { backupFile, target } = await this.promptService.promptForRestore();

    // Загружаем метаданные из файла
    const backupMetadata = this.backupService.loadBackupMetadata(backupFile);

    // Восстанавливаем резервную копию
    await this.restoreService.restoreBackup(backupMetadata, target);
  }

  async useRestorePreset(preset: RestorePreset): Promise<void> {
    const target = this.config.connections.find(
      (conn: ConnectionConfig) => conn.name === preset.targetName
    );

    if (!target) {
      throw new Error(`Цель "${preset.targetName}" не найдена в конфигурации`);
    }

    // Получаем список файлов резервных копий, соответствующих шаблону
    const backupFiles = this.backupService.getBackupFiles();

    let filteredFiles = backupFiles;
    if (preset.backupPattern) {
      const pattern = new RegExp(preset.backupPattern.replace('*', '.*'));
      filteredFiles = backupFiles.filter((file: string) => pattern.test(file));
    }

    if (filteredFiles.length === 0) {
      throw new Error('Не найдены файлы резервных копий, соответствующие шаблону');
    }

    // Выбираем файл резервной копии
    const { backupFile } = await inquirer.prompt({
      type: 'list',
      name: 'backupFile',
      message: 'Выберите файл резервной копии для восстановления:',
      choices: filteredFiles
    });

    // Загружаем метаданные резервной копии
    const backupMetadata = this.backupService.loadBackupMetadata(backupFile);

    // Подготавливаем команду
    const commandArgs = [
      `--host=${target.host || 'localhost'}:${target.port || 27017}`,
      `--db=${target.database}`,
      `--gzip`,
      `--archive=${path.join(this.config.backupDir, backupFile)}`,
      `--drop`
    ];

    console.log('\nКоманда для выполнения:');
    console.log(`mongorestore ${commandArgs.join(' ')}\n`);

    const { confirm } = await inquirer.prompt({
      type: 'confirm',
      name: 'confirm',
      message: 'Подтвердите выполнение команды:',
      default: true
    });

    if (confirm) {
      // Выполняем восстановление
      const spinner = ora('Восстановление резервной копии...').start();
      try {
        await this.restoreService.restoreBackup(backupMetadata, target);
        spinner.succeed(`Резервная копия успешно восстановлена в базу данных ${target.database}`);
      } catch (error) {
        spinner.fail(
          `Ошибка восстановления резервной копии: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }
}
