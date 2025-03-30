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

export interface RestorePreset {
  name: string;
  targetName: string;
  description?: string;
  backupPattern?: string;
  createdAt: string;
}

export interface AppConfig {
  backupDir: string;
  filenameFormat: string;
  mongodumpPath: string;
  mongorestorePath: string;
  connections: ConnectionConfig[];
  backupPresets?: BackupPreset[];
  restorePresets?: RestorePreset[];
}

export interface BackupMetadata {
  source: string;
  database: string;
  collections: string[];
  timestamp: number;
  date: string;
  archivePath: string;
}
