import * as fs from 'fs';
import * as path from 'path';
import type { AppConfig, ConnectionConfig } from '@ts-types/mixed';

import { formattedTimestamp } from '@utils/formatted-timestamp';
import { objectIdFromTimestamp } from '@utils/object-id-from-timestamp';
import { formatFilename } from '@utils/format-filename';
import { Logger } from '@infrastructure/logger';
import { BackupArgs } from '../interfaces/backup-args.interface';

export class Dump {
  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  buildArgs(source: ConnectionConfig, args: BackupArgs): { baseArgs: string[]; queryValue?: string } {
    const baseArgs: string[] = [];
    const { selectedCollections, excludedCollections, mode, startTime } = args;
    let queryValue: string | undefined = undefined;

    // --- Connection Arguments ---
    if (source.ssh) {
      // SSH mode: always use --db and separate fields
      if (!source.database) {
        throw new Error(`[${source.name}] Database name ('database') is required in config for SSH backup.`);
      }
      baseArgs.push(`--db=${source.database}`);

      let mongoHost = source.host;
      let mongoPort = source.port;

      if (!mongoHost && source.uri) {
        try {
          const parsedUri = new URL(source.uri);
          mongoHost = parsedUri.hostname;
          mongoPort = parseInt(parsedUri.port, 10) || undefined;
          this.logger.warn(
            `[${source.name}] Extracted MongoDB host/port from URI for SSH: ${mongoHost}:${mongoPort || 'default'}`,
          );
        } catch (e) {
          this.logger.warn(
            `[${source.name}] Could not parse MongoDB host/port from URI. Please define 'host' and 'port' explicitly in config for SSH backup.`,
          );
        }
      }

      if (mongoHost) baseArgs.push(`--host=${mongoHost}`);
      if (mongoPort) baseArgs.push(`--port=${mongoPort}`);

      if (source.username) baseArgs.push(`--username=${source.username}`);
      else this.logger.warn(`[${source.name}] SSH Backup: 'username' not found in config.`);

      if (source.password) baseArgs.push(`--password=${source.password}`);
      else if (source.username)
        this.logger.warn(`[${source.name}] SSH Backup: 'password' not found in config for user ${source.username}.`);

      const authDb = source.authenticationDatabase || source.authSource;
      if (authDb) {
        baseArgs.push(`--authenticationDatabase=${authDb}`);
      } else if (source.username) {
        let authSourceFromUri: string | null = null;
        if (source.uri) {
          try {
            const parsedUri = new URL(source.uri);
            authSourceFromUri = parsedUri.searchParams.get('authSource');
          } catch {
            /* ignore parsing error */
          }
        }
        if (authSourceFromUri) {
          baseArgs.push(`--authenticationDatabase=${authSourceFromUri}`);
          this.logger.error(`[${source.name}] Extracted authSource from URI: ${authSourceFromUri}`);
        } else {
          this.logger.warn(
            `[${source.name}] SSH Backup: 'authenticationDatabase' or 'authSource' not found in config or URI for user ${source.username}. Assuming 'admin' or target db might work.`,
          );
        }
      }
    } else {
      // Local mode: use URI if available
      if (source.uri) {
        baseArgs.push(`--uri="${source.uri}"`);
        if (source.database) {
          baseArgs.push(`--db=${source.database}`);
        }
      } else {
        if (!source.database) {
          throw new Error(
            `[${source.name}] Database name ('database') is required for local backup if URI is not provided.`,
          );
        }
        baseArgs.push(`--db=${source.database}`);
        if (source.host) baseArgs.push(`--host=${source.host}`);
        if (source.port) baseArgs.push(`--port=${source.port}`);
        if (source.username) baseArgs.push(`--username=${source.username}`);
        if (source.password) baseArgs.push(`--password=${source.password}`);
        const authDb = source.authenticationDatabase || source.authSource || source.database;
        if (authDb) baseArgs.push(`--authenticationDatabase=${authDb}`);
      }
    }
    // --- End Connection Arguments ---

    // --- Filtering Arguments ---
    if (startTime) {
      if (mode !== 'include' || selectedCollections.length !== 1) {
        throw new Error(
          'Internal error: startTime provided but mode is not "include" or selectedCollections count is not 1.',
        );
      }
      const collectionName = selectedCollections[0];
      baseArgs.push('--collection', collectionName);
      try {
        const startObjectId = objectIdFromTimestamp(startTime);
        queryValue = JSON.stringify({ _id: { $gte: { $oid: startObjectId } } });
        if (!source.ssh) {
          baseArgs.push('--query', queryValue);
        }
        this.logger.info(
          `Applying time filter to collection "${collectionName}": including documents with _id >= ${startObjectId} (time >= ${startTime.toISOString()})`,
        );
      } catch (e: any) {
        this.logger.error(`Error generating ObjectId for time filter: ${e.message}`);
        throw new Error('Failed to create time filter query.');
      }
    } else {
      if (mode === 'exclude' && excludedCollections.length > 0) {
        excludedCollections.forEach((coll) => baseArgs.push('--excludeCollection', coll));
        this.logger.info(`[${source.name}] Backup mode: excluding ${excludedCollections.length} collection(s)`);
      } else {
        this.logger.info(`[${source.name}] Backup mode: all collections`);
      }
    }
    // --- End Filtering Arguments ---

    baseArgs.push('--gzip');
    if (!queryValue) {
      baseArgs.push('--forceTableScan');
    }

    return queryValue ? { baseArgs, queryValue } : { baseArgs };
  }

  buildBackupFilePath(source: ConnectionConfig): string {
    this.ensureBackupDir();

    const now = new Date();
    const { date, time, datetime } = formattedTimestamp(now);
    const filename = formatFilename(
      this.config.filenameFormat || 'backup_{datetime}_{source}.gz',
      date,
      time,
      datetime,
      source.name,
    );
    const backupDir = path.resolve(this.config.backupDir);
    return path.join(backupDir, filename);
  }

  handleError(error: Error, source: ConnectionConfig, filePath: string, commandStringForLog?: string): never {
    const errorMsg = `Error creating backup for ${source.name}: ${error.message}`;
    this.logger.error(errorMsg);
    if (commandStringForLog) {
      this.logger.error(`Failed command (approximate): ${commandStringForLog}`);
    }
    this.cleanupFile(filePath);
    throw new Error(`Backup failed for ${source.name}.`);
  }

  private ensureBackupDir(): string {
    const backupDir = path.resolve(this.config.backupDir);
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
      this.logger.succeedSpinner(`Created backup directory: ${backupDir}`);
    }
    return backupDir;
  }

  private cleanupFile(filePath: string): void {
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
        this.logger.succeedSpinner(`Cleaned up incomplete backup file: ${filePath}`);
      } catch (cleanupError: any) {
        this.logger.failSpinner(`Failed to cleanup incomplete backup file ${filePath}: ${cleanupError.message}`);
      }
    }
  }
}
