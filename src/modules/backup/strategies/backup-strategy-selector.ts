import { AppConfig, ConnectionConfig } from '@ts-types/mixed';
import { LocalBackupStrategy } from './local-backup-strategy';
import { SshBackupStrategy } from './ssh-backup-strategy';
import { Logger } from '@infrastructure/logger';
import { SshBackupRunner } from '../services/ssh-backup-runner';

export class BackupStrategySelector {
  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  select(source: ConnectionConfig) {
    return source.ssh
      ? new SshBackupStrategy(
          this.config,
          this.logger,
          new SshBackupRunner(this.logger.extendPrefix(SshBackupStrategy.name)),
        )
      : new LocalBackupStrategy(this.config, this.logger.extendPrefix(LocalBackupStrategy.name));
  }
}
