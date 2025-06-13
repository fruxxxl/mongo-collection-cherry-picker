import { RestoreOptions } from './restore-options.interface';

export interface RestorePreset {
  name: string;
  targetName: string;
  backupPattern?: string;
  options?: RestoreOptions;
  createdAt?: string;
  description?: string;
}
