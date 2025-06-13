import { ConnectionConfig } from '../../../types/types';
import { BackupArgs } from './backup-args.interface';

export interface BackupStrategy {
  /**
   * Creates a backup of the MongoDB database using mongodump.
   * @param source - The configuration of the source MongoDB connection.
   * @param args - Arguments for backup filtering and configuration.
   * @returns A promise that resolves with the absolute path to the created backup archive file.
   * @throws An error if the backup process fails.
   */
  createBackup(source: ConnectionConfig, args: BackupArgs): Promise<string>;
}
