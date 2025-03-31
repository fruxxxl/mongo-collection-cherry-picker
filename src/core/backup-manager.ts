import ora from 'ora';
import inquirer from 'inquirer';
import { MongoDBService } from '../services/mongodb.service';
import { BackupService } from '../services/backup.service';
import { RestoreService } from '../services/restore.service';
import { PromptService } from '../utils/prompts';
import { AppConfig, ConnectionConfig } from '../types/index';

export class BackupManager {
  private config: AppConfig;
  private mongoService: MongoDBService;
  private backupService: BackupService;
  private promptService: PromptService;

  constructor(config: AppConfig) {
    this.config = config;
    this.mongoService = new MongoDBService(config);
    this.backupService = new BackupService(config);
    this.promptService = new PromptService(config);
  }

  async runBackup(
    sourceName: string,
    mode: 'all' | 'include' | 'exclude',
    collectionsList: string[] = []
  ): Promise<string> {
    // Находим подключение по имени
    const sourceConfig = this.config.connections.find(
      (conn: ConnectionConfig) => conn.name === sourceName
    );
    if (!sourceConfig) {
      throw new Error(`Подключение "${sourceName}" не найдено в конфигурации`);
    }

    // Подключаемся к MongoDB
    await this.mongoService.connect(sourceConfig);
    console.log(`Подключение успешно установлено к ${sourceName}`);

    // Получаем список коллекций
    const allCollections = await this.mongoService.getCollections(sourceConfig.database);
    await this.mongoService.close();

    // Определяем коллекции для резервного копирования
    let includedCollections: string[] = [];
    let excludedCollections: string[] = [];

    if (mode === 'all') {
      includedCollections = allCollections;
    } else if (mode === 'include') {
      includedCollections = collectionsList;
    } else if (mode === 'exclude') {
      excludedCollections = collectionsList;
      includedCollections = allCollections.filter(
        (col: string) => !excludedCollections.includes(col)
      );
    }

    // Создаем резервную копию
    const backupPath = await this.backupService.createBackup(
      sourceConfig,
      includedCollections,
      excludedCollections
    );

    console.log(`Резервная копия успешно создана: ${backupPath}`);
    return backupPath;
  }

  async backupDatabase(): Promise<void> {
    // Используем PromptService для интерактивного выбора
    const { source, selectedCollections, excludedCollections } =
      await this.promptService.promptForBackup();

    // Подключение к MongoDB и получение списка коллекций
    const spinner = ora('Подключение к базе данных...').start();

    try {
      await this.mongoService.connect(source);
      spinner.succeed('Подключение успешно установлено');

      spinner.start('Получение списка коллекций...');
      const collections = await this.mongoService.getCollections(source.database);
      spinner.succeed(`Получено ${collections.length} коллекций`);

      await this.mongoService.close();

      // Создаем резервную копию
      spinner.start('Создание резервной копии...');
      const backupPath = await this.backupService.createBackup(
        source,
        selectedCollections,
        excludedCollections
      );
      spinner.succeed(`Резервная копия успешно создана: ${backupPath}`);

      // Предлагаем восстановить резервную копию в другую базу данных
      const { restore } = await inquirer.prompt({
        type: 'confirm',
        name: 'restore',
        message: 'Хотите восстановить резервную копию в другую базу данных?',
        default: false
      });

      if (restore) {
        const backupMetadata = this.backupService.loadBackupMetadata(backupPath);
        const { target } = await this.promptService.promptForRestoreTarget(backupMetadata, source);
        const restoreService = new RestoreService(this.config);

        await restoreService.restoreBackup(backupMetadata, target);
      } else {
        console.log('Работа завершена. Хорошего дня!');
        process.exit(0);
      }
    } catch (error) {
      spinner.fail(`Ошибка: ${error instanceof Error ? error.message : String(error)}`);
      await this.mongoService.close();
    }
  }

  async useBackupPreset(preset: any): Promise<void> {
    const source = this.config.connections.find(
      (conn: ConnectionConfig) => conn.name === preset.sourceName
    );

    if (!source) {
      throw new Error(`Источник "${preset.sourceName}" не найден в конфигурации`);
    }

    // Создаем массивы выбранных/исключенных коллекций на основе пресета
    let selectedCollections: string[] = [];
    let excludedCollections: string[] = [];

    if (preset.selectionMode === 'all') {
      // Все коллекции
      await this.mongoService.connect(source);
      selectedCollections = await this.mongoService.getCollections(source.database);
      await this.mongoService.close();
    } else if (preset.selectionMode === 'include') {
      // Только указанные коллекции
      selectedCollections = preset.collections || [];
    } else {
      // Исключаем указанные коллекции
      excludedCollections = preset.collections || [];

      // Получаем все коллекции, чтобы исключить указанные
      await this.mongoService.connect(source);
      const allCollections = await this.mongoService.getCollections(source.database);
      await this.mongoService.close();

      selectedCollections = allCollections.filter(
        (coll: string) => !excludedCollections.includes(coll)
      );
    }

    // Проверяем команду перед выполнением
    const commandArgs = [
      `--host=${source.host || 'localhost'}:${source.port || 27017}`,
      `--db=${source.database}`,
      `--gzip`,
      `--archive=./backups/backup_example.gz`
    ];

    if (preset.selectionMode === 'exclude') {
      excludedCollections.forEach((coll: string) => {
        commandArgs.push(`--excludeCollection=${coll}`);
      });
    } else if (preset.selectionMode === 'include') {
      selectedCollections.forEach((coll: string) => {
        commandArgs.push(`--collection=${coll}`);
      });
    }

    console.log('\nВыполнение команды mongodump:');
    console.log(`mongodump ${commandArgs.join(' ')}\n`);

    const { confirm } = await inquirer.prompt({
      type: 'confirm',
      name: 'confirm',
      message: 'Подтвердите выполнение команды:',
      default: true
    });

    if (confirm) {
      // Выполняем резервное копирование
      const spinner = ora('Создание резервной копии...').start();
      try {
        spinner.text = 'Выполнение mongodump...';
        const backupPath = await this.backupService.createBackup(
          source,
          selectedCollections,
          excludedCollections
        );
        spinner.succeed(`Резервная копия успешно создана: ${backupPath}`);
      } catch (error) {
        spinner.fail(
          `Ошибка создания резервной копии: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }
}
