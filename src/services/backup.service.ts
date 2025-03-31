import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { AppConfig, BackupMetadata, ConnectionConfig, RestoreOptions } from '../types';

import { MongoDBService } from './mongodb.service';
import { execPromise } from '../utils/execPromise';

export class BackupService {
  private config: AppConfig;

  constructor(config: AppConfig) {
    this.config = config;
  }

  async createBackup(
    source: ConnectionConfig,
    selectedCollections: string[],
    excludedCollections: string[]
  ): Promise<string> {
    try {
      // Create backup directory if it doesn't exist
      if (!fs.existsSync(this.config.backupDir)) {
        fs.mkdirSync(this.config.backupDir, { recursive: true });
      }

      const timestamp = Date.now();
      const formattedDate = new Date().toISOString().split('T')[0];

      // Format file name
      const filename = this.config.filenameFormat
        .replace('{{timestamp}}', timestamp.toString())
        .replace('{{source}}', source.name.replace(/\s+/g, '_').toLowerCase())
        .replace('{{date}}', formattedDate);

      const filePath = path.join(this.config.backupDir, filename);

      // Prepare arguments for mongodump
      const args: string[] = [];

      // URI or host/port
      if (source.uri) {
        args.push(`--uri="${source.uri}"`);
      } else if (source.host) {
        args.push(`--host=${source.host}${source.port ? `:${source.port}` : ''}`);
      }

      // Database
      args.push(`--db=${source.database}`);

      // Authentication
      if (source.username) {
        args.push(`--username=${source.username}`);
      }

      if (source.password) {
        args.push(`--password=${source.password}`);
      }

      if (source.authenticationDatabase) {
        args.push(`--authenticationDatabase=${source.authenticationDatabase}`);
      }

      // Include only selected collections, if not all
      if (excludedCollections.length > 0) {
        // Collection exclusion mode
        for (const collection of excludedCollections) {
          args.push(`--excludeCollection=${collection}`);
        }
      } else if (selectedCollections.length > 0) {
        // Mode to include only specified collections
        for (const collection of selectedCollections) {
          args.push(`--collection=${collection}`);
        }
      }

      // Output formatting
      args.push('--gzip');
      args.push(`--archive=${filePath}`);

      // Display command before execution
      console.log('\nExecuting mongodump command:');
      const commandString = `${this.config.mongodumpPath || 'mongodump'} ${args.join(' ')}`;
      console.log(`${commandString}\n`);

      // If SSH is used
      if (source.ssh) {
        // For SSH tunnel we need to create mongodump through SSH
        const sshArgs = [
          `-i`,
          source.ssh.privateKey,
          `-p`,
          source.ssh.port.toString(),
          `${source.ssh.username}@${source.ssh.host}`,
          `mongodump ${args.join(' ')}`
        ];

        // Create stream for writing to file
        const outputFile = fs.createWriteStream(filePath);

        // Execute SSH command
        const sshProcess = spawn('ssh', sshArgs);

        sshProcess.stdout.pipe(outputFile);

        // Error handling
        let errorOutput = '';
        sshProcess.stderr.on('data', (data) => {
          errorOutput += data.toString();
        });

        // Wait for process completion
        const exitCode = await new Promise<number>((resolve) => {
          sshProcess.on('close', resolve);
        });

        if (exitCode !== 0) {
          throw new Error(`SSH mongodump finished with an error: ${errorOutput}`);
        }
      } else {
        // Run mongodump directly
        const mongodumpProcess = spawn(this.config.mongodumpPath || 'mongodump', args);

        // Add stdout handling for progress tracking
        mongodumpProcess.stdout.on('data', (data) => {
          const output = data.toString();
          if (output.trim()) {
            console.log(`[mongodump stdout]: ${output.trim()}`);
          }
        });

        // Error handling
        let errorOutput = '';
        mongodumpProcess.stderr.on('data', (data) => {
          errorOutput += data.toString();
        });

        // Wait for process completion
        const exitCode = await new Promise<number>((resolve) => {
          mongodumpProcess.on('close', resolve);
        });

        if (exitCode !== 0) {
          throw new Error(`mongodump finished with an error: ${errorOutput}`);
        }
      }

      // Create backup metadata
      const backupMetadata: BackupMetadata = {
        source: source.name,
        database: source.database,
        collections: selectedCollections,
        timestamp,
        date: new Date().toISOString(),
        archivePath: filename
      };

      // Save metadata to a file alongside the archive
      const metadataPath = `${filePath}.json`;
      fs.writeFileSync(metadataPath, JSON.stringify(backupMetadata, null, 2));

      return filePath;
    } catch (error) {
      console.error(`Error creating backup: ${error}`);
      throw error;
    }
  }

  getBackupFiles(): string[] {
    if (!fs.existsSync(this.config.backupDir)) {
      return [];
    }

    return fs
      .readdirSync(this.config.backupDir)
      .filter((file) => file.endsWith('.gz'))
      .sort()
      .reverse();
  }

  loadBackupMetadata(archivePath: string): BackupMetadata {
    const fileName = path.basename(archivePath);

    const fullPath = path.join(this.config.backupDir, fileName);

    const metadataPath = `${fullPath}.json`;

    if (!fs.existsSync(metadataPath)) {
      throw new Error(`Backup metadata file not found: ${metadataPath}`);
    }

    const metadataJson = fs.readFileSync(metadataPath, 'utf8');
    return JSON.parse(metadataJson);
  }

  /**
   * Finds the full path to the archive file, trying different path combinations
   * @param archivePath Original path to the archive
   * @returns Full path to the file or null if the file is not found
   */
  findArchiveFile(archivePath: string): string | null {
    // Array of possible paths to check
    const pathsToCheck = [
      archivePath,
      path.join(this.config.backupDir, archivePath),
      path.join(process.cwd(), archivePath),
      path.join(process.cwd(), this.config.backupDir, archivePath),
      // Remove backupDir from path if it already exists
      archivePath.replace(`${this.config.backupDir}/`, '')
    ];

    // If path starts with ./ or ../, add also the absolute path
    if (archivePath.startsWith('./') || archivePath.startsWith('../')) {
      pathsToCheck.push(path.resolve(archivePath));
    }

    console.log('Searching for archive file. Checking paths:');
    for (const p of pathsToCheck) {
      console.log(`- ${p} (${fs.existsSync(p) ? 'exists' : 'does not exist'})`);
      if (fs.existsSync(p)) {
        return p;
      }
    }

    // Try searching by mask if previous attempts failed
    const fileBaseName = path.basename(archivePath);
    console.log(`Searching by mask: *${fileBaseName}`);

    try {
      // Check if directory exists before reading
      if (fs.existsSync(this.config.backupDir)) {
        const files = fs.readdirSync(this.config.backupDir);
        console.log(`Files in directory ${this.config.backupDir}:`, files);

        // Search for file with the same name
        const matchingFile = files.find((f) => f === fileBaseName);
        if (matchingFile) {
          const fullPath = path.join(this.config.backupDir, matchingFile);
          console.log(`Found matching file: ${fullPath}`);
          return fullPath;
        }
      }
    } catch (error) {
      console.error(`Error trying to find file by mask: ${error}`);
    }

    return null;
  }

  async restoreBackup(
    target: ConnectionConfig,
    archivePath: string,
    options: RestoreOptions = {}
  ): Promise<boolean> {
    try {
      // Проверяем существование архива
      console.log(`Full path to backup directory: ${path.resolve(this.config.backupDir)}`);
      console.log('Searching for archive file. Checking paths:');
      console.log(`- ${archivePath} (${fs.existsSync(archivePath) ? 'exists' : 'not found'})`);

      if (!fs.existsSync(archivePath)) {
        throw new Error(`Backup archive not found: ${archivePath}`);
      }

      // Выводим размер архива
      const stats = fs.statSync(archivePath);
      console.log(`Archive size: ${stats.size} bytes`);

      // Формируем команду для восстановления с классическими параметрами
      const sourceDb = this.getSourceDatabaseFromMetadata(archivePath);

      // Базовая команда
      const restoreCommand = [
        this.config.mongorestorePath || 'mongorestore',
        `--host=${target.host || 'localhost'}:${target.port || 27017}`,
        `--gzip`,
        `--archive=${archivePath}`
      ];

      // Если исходная и целевая БД разные, добавляем параметры трансформации
      if (sourceDb && sourceDb !== target.database) {
        // Используем только один раз параметры nsFrom и nsTo
        restoreCommand.push(`--nsFrom=${sourceDb}.*`, `--nsTo=${target.database}.*`);
      } else {
        // Если БД одинаковые или нет информации об исходной, просто указываем целевую БД
        restoreCommand.push(`--db=${target.database}`);
      }

      // Добавляем опцию --drop, если указано
      if (options.drop) {
        restoreCommand.push('--drop');
      }

      // Добавляем аутентификацию если указана
      if (target.username && target.password) {
        restoreCommand.push(`--username=${target.username}`, `--password=${target.password}`);

        if (target.authSource || target.authenticationDatabase) {
          restoreCommand.push(
            `--authenticationDatabase=${target.authSource || target.authenticationDatabase}`
          );
        }
      }

      console.log(`EXECUTING COMMAND: ${restoreCommand.join(' ')}`);

      // Выполняем команду
      const { stdout, stderr } = await execPromise(restoreCommand.join(' '));

      // Фильтруем и отображаем сообщения из stderr
      if (stderr) {
        // Разделяем по строкам
        const errorLines = stderr.split('\n').filter((line) => line.trim());

        // Проверяем каждую строку на наличие реальной ошибки
        const realErrors = errorLines.filter(
          (line) =>
            line.includes('error:') ||
            line.includes('failed') ||
            line.includes('exception') ||
            line.includes('Error:')
        );

        // Если есть реальные ошибки, выводим их как ошибки
        if (realErrors.length > 0) {
          console.error('[mongorestore errors]:', realErrors.join('\n'));
        }

        // Остальные строки выводим как информационные сообщения
        const infoLines = errorLines.filter((line) => !realErrors.includes(line));
        if (infoLines.length > 0) {
          console.log('[mongorestore info]:', infoLines.join('\n'));
        }
      }

      // Выводим информацию из stdout, если есть
      if (stdout) {
        console.log('[mongorestore output]:', stdout);
      }

      // Проверяем результат восстановления
      console.log(`Checking restoration results in ${target.database}...`);
      await this.checkRestoreResults(target);

      return true;
    } catch (error) {
      console.error(
        `Error restoring backup: ${error instanceof Error ? error.message : String(error)}`
      );
      return false;
    }
  }

  // Вспомогательный метод для получения имени исходной БД из метаданных
  private getSourceDatabaseFromMetadata(archivePath: string): string | null {
    try {
      const metadataPath = archivePath + '.json';
      if (fs.existsSync(metadataPath)) {
        const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
        return metadata.database;
      }
    } catch (error) {
      console.error('Error reading metadata:', error);
    }
    return null;
  }

  // Вспомогательный метод для проверки результатов восстановления
  private async checkRestoreResults(target: ConnectionConfig): Promise<void> {
    try {
      const mongoService = new MongoDBService(this.config);
      await mongoService.connect(target);

      const collections = await mongoService.getCollections(target.database);
      console.log(`Found ${collections.length} collections in the database ${target.database}`);

      if (collections.length > 0) {
        console.log(`Collections: ${collections.join(', ')}`);
      }

      await mongoService.close();
    } catch (error) {
      console.error('Error checking restore results:', error);
    }
  }
}
