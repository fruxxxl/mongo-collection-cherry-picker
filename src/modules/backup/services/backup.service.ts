/* eslint-disable quotes */
import * as fs from 'fs';
import * as path from 'path';
import type { AppConfig, BackupMetadata, ConnectionConfig } from '../../../types/types';
import { Logger } from '../../../infrastructure/logger';

import { SshBackupRunner } from './ssh-backup-runner';

import { BackupStrategySelector } from '../strategies/backup-strategy-selector';
import { LocalBackupStrategy } from '../strategies/local-backup-strategy';
import { SshBackupStrategy } from '../strategies/ssh-backup-strategy';

/**
 * Handles the execution of mongodump command for creating MongoDB backups.
 * Supports both direct database connections and connections via SSH tunnel.
 */
export class BackupService {
  private readonly strategySelector: BackupStrategySelector;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {
    const localStrategy = new LocalBackupStrategy(config, logger);
    const sshStrategy = new SshBackupStrategy(config, logger, new SshBackupRunner(logger));
    this.strategySelector = new BackupStrategySelector(localStrategy, sshStrategy);
  }

  /**
   * Executes the mongodump command to create a backup archive (.gz).
   * Determines whether to run mongodump locally or remotely via SSH based on the source configuration.
   * Handles collection filtering based on provided arguments.
   *
   * @param source - The configuration of the source MongoDB connection.
   * @param selectedCollections - An array of collection names for the `--collection` flag (should be empty if mode is 'exclude' or 'all').
   * @param excludedCollections - An array of collection names for the `--excludeCollection` flag (used when mode is 'exclude').
   * @param mode - Specifies the effective mode for the mongodump command ('all', 'include', 'exclude').
   * @param startTime - Optional start time to filter documents using --query on _id.
   * @returns A promise that resolves with the absolute path to the created backup archive file.
   * @throws An error if the backup process fails.
   */
  async createBackup(
    source: ConnectionConfig,
    selectedCollections: string[],
    excludedCollections: string[],
    mode: 'all' | 'include' | 'exclude',
    startTime?: Date,
  ): Promise<string> {
    const args = { selectedCollections, excludedCollections, mode, startTime };
    const strategy = this.strategySelector.select(source);
    return strategy.createBackup(source, args);
  }

  /**
   * Loads backup metadata from the .json file corresponding to a backup archive.
   * @param backupFilename - The filename of the backup archive (e.g., backup_....gz).
   * @returns The parsed BackupMetadata object.
   * @throws An error if the metadata file is not found or cannot be parsed.
   */
  loadBackupMetadata(backupFilename: string): BackupMetadata {
    const metadataPath = path.join(this.config.backupDir, `${backupFilename}.json`);
    if (!fs.existsSync(metadataPath)) {
      this.logger.warn(`Metadata file not found: ${metadataPath}`);
      throw new Error(`Metadata file not found: ${metadataPath}`);
    }
    try {
      const metadataContent = fs.readFileSync(metadataPath, 'utf-8');
      const metadata = JSON.parse(metadataContent) as BackupMetadata;
      if (!metadata.source || !metadata.timestamp || !metadata.archivePath) {
        this.logger.error(`Metadata file ${metadataPath} is missing required fields.`);
        throw new Error('Metadata file is missing required fields (source, timestamp, archivePath).');
      }
      metadata.archivePath = path.basename(metadata.archivePath);
      return metadata;
    } catch (error: any) {
      this.logger.error(`Failed to load or parse metadata file ${metadataPath}: ${error.message}`);
      throw new Error(`Failed to load or parse metadata file ${metadataPath}.`);
    }
  }

  /**
   * Lists backup archive files (.gz) in the backup directory, sorted newest first.
   * @returns An array of backup filenames.
   */
  getBackupFiles(): string[] {
    const backupDir = path.resolve(this.config.backupDir);
    if (!fs.existsSync(backupDir)) {
      return [];
    }
    try {
      const files = fs.readdirSync(backupDir);
      return files
        .filter((file) => file.endsWith('.gz') && !file.startsWith('.'))
        .map((file) => {
          try {
            return { name: file, time: fs.statSync(path.join(backupDir, file)).mtime.getTime() };
          } catch (e: any) {
            this.logger.warn(`Could not stat file ${file} in backup dir: ${e.message}`);
            return { name: file, time: 0 };
          }
        })
        .sort((a, b) => b.time - a.time)
        .map((file) => file.name);
    } catch (error: any) {
      this.logger.error(`Error reading backup directory ${backupDir}: ${error.message}`);
      return [];
    }
  }
}
