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
  preset?: string;
}

export interface ConfigType {
  connections: ConnectionConfig[];
  backupDir: string;
  backupPresets?: BackupPreset[];
  [key: string]: any;
}
