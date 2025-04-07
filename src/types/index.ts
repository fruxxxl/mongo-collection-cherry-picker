export interface SSHConfig {
  host: string;
  port: number;
  username: string;
  privateKey: string;
  passphrase?: string;
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
 * Represents the metadata associated with a backup archive.
 * Stored in a .json file alongside the .gz archive.
 */
export interface BackupMetadata {
  /** The name of the source connection used for the backup. */
  source: string;
  /** The name of the database that was backed up. */
  database?: string;
  /**
   * List of collection names explicitly included in the backup.
   * Relevant when selectionMode is 'include'. May be empty if selectionMode is 'all' or 'exclude'.
   */
  includedCollections: string[];
  /** The selection mode used during backup ('all', 'include', 'exclude'). */
  selectionMode: 'all' | 'include' | 'exclude';
  /** List of collections explicitly excluded (only relevant if selectionMode is 'exclude'). */
  excludedCollections?: string[];
  /** Unix timestamp (milliseconds) when the backup was created. */
  timestamp: number;
  /** ISO 8601 string representation of the backup creation date/time. */
  date: string;
  /** The relative path/filename of the backup archive within the backup directory. */
  archivePath: string;
}

export interface CommandLineArgs {
  interactive?: boolean;
  mode?: string;
  source?: string;
  backupMode?: 'all' | 'include' | 'exclude';
  collections?: string[];
  backupFile?: string;
  target?: string;
  configPath?: string;
  drop?: boolean;
}

export interface ConfigType {
  connections: ConnectionConfig[];
  backupDir: string;
  backupPresets?: BackupPreset[];
  [key: string]: any;
}
