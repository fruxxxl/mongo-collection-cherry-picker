import { z } from 'zod';

export const SSHConfigSchema = z.object({
  host: z.string(),
  port: z.number().default(22),
  username: z.string(),
  privateKey: z.string(),
  passphrase: z.string().optional(),
});

export const ConnectionConfigSchema = z.object({
  name: z.string(),
  uri: z.string(),
  database: z.string(),
  host: z.string().optional(),
  port: z.number().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  authenticationDatabase: z.string().optional(),
  ssh: SSHConfigSchema.optional(),
});

export const BackupPresetSchema = z.object({
  name: z.string(),
  sourceName: z.string(),
  description: z.string().optional(),
  selectionMode: z.enum(['all', 'include', 'exclude']),
  collections: z.array(z.string()).optional(),
  createdAt: z.string(),
});

export const AppConfigSchema = z.object({
  backupDir: z.string().default('./backups'),
  filenameFormat: z.string().default('backup_{{datetime}}_{{source}}.gz'),
  connections: z.array(ConnectionConfigSchema),
  mongodumpPath: z.string().optional().default('mongodump'),
  mongorestorePath: z.string().optional().default('mongorestore'),
  backupPresets: z.array(BackupPresetSchema).optional(),
});
