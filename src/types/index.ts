export interface SSHConfig {
  host: string;
  port: number;
  username: string;
  privateKey: string;
  passphrase?: string;
  password?: string;
}

export interface ConnectionConfig {
  name: string;
  uri?: string;
  database: string;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  authenticationDatabase?: string;
  authSource?: string;
  authDatabase?: string;
  hosts?: Array<{ host: string; port?: number }>;
  replicaSet?: string;
  options?: Record<string, any>;
  ssh?: SSHConfig;
}

export interface BackupPreset {
  name: string;
  sourceName: string;
  description?: string;
  selectionMode: 'all' | 'include' | 'exclude';
  collections?: string[];
  createdAt: string;
  queryStartTime?: string;
}

export interface RestoreOptions {
  drop?: boolean;
}

export interface RestorePreset {
  name: string;
  targetName: string;
  backupPattern?: string;
  options?: RestoreOptions;
  createdAt?: string;
  description?: string;
}

export interface AppConfig {
  backupDir: string;
  filenameFormat: string;
  mongodumpPath: string;
  mongorestorePath: string;
  connections: ConnectionConfig[];
  backupPresets?: BackupPreset[];
}

/**
 * Represents the metadata stored alongside a backup archive.
 * Contains information about the source, creation time, and filtering used.
 */
export interface BackupMetadata {
  /** The name of the source connection used for the backup. */
  source: string;
  /** The name of the database backed up. */
  database: string;
  /** The selection mode intended by the user ('all', 'include', 'exclude'). */
  selectionMode: 'all' | 'include' | 'exclude';
  /** List of collections explicitly included (only if selectionMode is 'include'). */
  includedCollections?: string[];
  /** List of collections explicitly excluded (only if selectionMode is 'exclude'). */
  excludedCollections?: string[];
  /** Unix timestamp (milliseconds) when the backup was created. */
  timestamp: number;
  /** ISO 8601 string representation of the backup creation date/time. */
  date: string;
  /** The filename of the backup archive (e.g., backup_....gz). */
  archivePath: string;
  /** Optional: The name of the preset used to create this backup. */
  presetName?: string;
  /** ISO 8601 string representation of the start time used for the --query filter based on _id, if applied. */
  queryStartTime?: string;
}

export interface CommandLineArgs {
  /** Flag indicating if the application should run in interactive mode. */
  interactive?: boolean;
  /** The primary operation mode ('backup' or 'restore'), usually undefined in interactive mode. */
  mode?: 'backup' | 'restore';
  /** Name of the source connection (for backup). */
  source?: string;
  /** Backup mode ('all', 'include', 'exclude'). */
  backupMode?: 'all' | 'include' | 'exclude';
  /** List of collections for include/exclude mode. */
  collections?: string[];
  /** Name of the backup or restore preset to use. */
  preset?: string;
  /** Specific backup file to restore. */
  backupFile?: string;
  /** Name of the target connection (for restore). */
  target?: string;
  /** Flag to drop target collections before restoring. */
  drop?: boolean;
  /** Filter backup by _id timestamp (ISO 8601 or relative like "1d", "7d", "3h"). */
  sinceTime?: string;
}

export interface ConfigType {
  connections: ConnectionConfig[];
  backupDir: string;
  backupPresets?: BackupPreset[];
  [key: string]: any;
}
