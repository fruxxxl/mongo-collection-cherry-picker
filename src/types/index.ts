export interface SSHConfig {
  host: string;
  port: number;
  username: string;
  privateKey: string;
  passphrase?: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
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

export interface BackupMetadata {
  source: string;
  database: string;
  collections: string[];
  timestamp: number;
  date: string;
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
