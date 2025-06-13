import { ConnectionConfig } from '@ts-types/mixed';
import { LocalBackupStrategy } from './local-backup-strategy';
import { SshBackupStrategy } from './ssh-backup-strategy';

export class BackupStrategySelector {
  constructor(
    private readonly localStrategy: LocalBackupStrategy,
    private readonly sshStrategy: SshBackupStrategy,
  ) {}

  select(source: ConnectionConfig) {
    return source.ssh ? this.sshStrategy : this.localStrategy;
  }
}
