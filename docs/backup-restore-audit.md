# Backup & Restore Workflow Audit

## Scope
- Review of backup orchestration (`backup-controller.ts`, `backup.service.ts`), dump argument builder (`domain/dump.ts`), strategy implementations (`local-backup-strategy.ts`, `ssh-backup-strategy.ts`, `ssh-backup-runner.ts`).
- Review of restore orchestration (`restore-controller.ts`, `restore.service.ts`).
- Identification of functional gaps, performance bottlenecks, and operational risks (SSH lifecycle, large data handling, logging, metadata consistency).

## High Priority Findings

### 1. `--forceTableScan` applied to every full backup
- **Impact:** Forces collection scans even when indexes are available, dramatically slowing large backups and increasing load on primaries.
- **Evidence:**
  ```ts
  // src/modules/backup/domain/dump.ts
  136:     baseArgs.push('--gzip');
  137:     if (!queryValue) {
  138:       baseArgs.push('--forceTableScan');
  139:     }
  ```
- **Notes:** Consider making table scans opt-in; allow indexed dumps by default and expose a configuration flag for force scans in edge cases.

### 2. Credentials exposed in structured logs
- **Impact:** Logged mongodump/mongorestore commands include `--username`/`--password`, leaking secrets to console, log files, and telemetry.
- **Evidence:**
  ```ts
  // src/modules/backup/strategies/local-backup-strategy.ts
  26:     const commandString = `mongodump ${baseArgs.map((arg) => (arg.includes(' ') ? `"${arg}"` : arg)).join(' ')}`;
  27:     this.logger.info(`[${source.name}] Running mongodump command: ...\n      ${commandString}`);
  ```
  ```ts
  // src/modules/backup/services/ssh-backup-runner.ts
  90:       this.logger.info(`Running mongodump command:\n      ${remoteCommand}`);
  ```
  ```ts
  // src/modules/restore/services/restore.service.ts
  187:         this.logger.info('Executing local mongorestore command:');
  188:         this.logger.snippet(commandStringForLog);
  ```
- **Notes:** Redact credentials (or avoid logging the full command) before emitting to logs.

### 3. Quoted `--uri` arguments break spawned processes
- **Impact:** Supplying a URI causes mongodump/mongorestore to receive the literal string `--uri="mongodb://..."`, which includes quotes because `spawn` bypasses shell parsing. This leads to authentication and connection failures for URI-based configurations.
- **Evidence:**
  ```ts
  // src/modules/backup/domain/dump.ts
  82:       if (source.uri) {
  83:         baseArgs.push(`--uri="${source.uri}"`);
  ```
  ```ts
  // src/modules/restore/services/restore.service.ts
  53:       baseArgs.push(`--uri="${target.uri}"`);
  ```
- **Notes:** Pass URIs without embedded quotes (e.g. `--uri=${source.uri}`) or use separate argument entries to keep spawn-compatible. Issue affects both backup and restore flows.

### 4. Restore over SSH explicitly unsupported
- **Impact:** Targets that require SSH cannot be restored, blocking disaster-recovery for remote clusters.
- **Evidence:**
  ```ts
  // src/modules/restore/services/restore.service.ts
  100:       if (target.ssh) {
  101:         this.logger.warn('SSH restore not supported yet.');
  ```
- **Notes:** Need parity with backup-side SSH streaming (or clear error surfaced earlier in workflow).

## Medium Priority Findings

### 5. Metadata records user intent, not actual backup scope
- **Impact:** Metadata saved alongside archives may claim `selectionMode:"include"` even when runtime logic falls back to `all`/`exclude`, misleading restore planning.
- **Evidence:**
  ```ts
  // src/modules/backup/controllers/backup-controller.ts
  75:         selectionMode: intendedMode,
  76:         includedCollections: intendedMode === 'include' ? collectionsListForMetadata : undefined,
  77:         excludedCollections: intendedMode === 'exclude' ? collectionsListForMetadata : undefined,
  ```
  ```ts
  // src/modules/backup/controllers/backup-controller.ts
  318:           this.logger.warn(... 'None of the specified collections ... Backing up all collections.');
  320:           return { actualMode: 'all', ... };
  ```
- **Notes:** Persist the effective mode (`actualMode`, `actualSelected`, `actualExcluded`) into metadata so restore decisions match what was dumped.

### 6. Time-filtered backups assume ObjectId identifiers
- **Impact:** `_id` fields using UUIDs/strings cannot be filtered by `queryStartTime`; attempting to do so throws and aborts the backup.
- **Evidence:**
  ```ts
  // src/modules/backup/domain/dump.ts
  114:         const startObjectId = objectIdFromTimestamp(startTime);
  115:         queryValue = JSON.stringify({ _id: { $gte: { $oid: startObjectId } } });
  123:         this.logger.error(`Error generating ObjectId for time filter: ${e.message}`);
  124:         throw new Error('Failed to create time filter query.');
  ```
- **Notes:** Detect non-ObjectId `_id` shapes and either skip the filter with a warning or allow custom field selection.

### 7. Collection discovery adds latency and can fall back silently
- **Impact:** Each include-mode backup opens a driver connection to list all collections, which may be slow on large/remote clusters and silently broadens scope if discovery fails.
- **Evidence:**
  ```ts
  // src/modules/backup/controllers/backup-controller.ts
  304:         await this.mongoService.connect(source);
  305:         const allCollections = await this.mongoService.getCollections(source.database);
  307:         await this.mongoService.close();
  333:         this.logger.failSpinner(... 'Failed to fetch collection list');
  334:         this.logger.warn(... 'Fallback to backing up all collections.');
  ```
- **Notes:** Surface discovery failures to the caller (instead of silently widening scope), and consider caching or reusing the collection list when chaining backups.

### 8. Restore controller swallows errors
- **Impact:** `runRestore` logs failures but does not rethrow, preventing upstream CLI/error handlers from setting proper exit codes.
- **Evidence:**
  ```ts
  // src/modules/restore/controllers/restore-controller.ts
  80:     } catch (error: any) {
  81:       if (this.logger.spinner?.isSpinning) {
  82:         this.logger.failSpinner(`Restore operation failed: ${error.message}`);
  ...
  84:         this.logger.error(`✖ Restore operation failed: ${error.message}`);
  85:       }
  86:       if (this.logger.spinner?.isSpinning) {
  87:         this.logger.stopSpinner();
  88:       }
  ```
- **Notes:** Re-throw or propagate an exit code so automation can detect restore failures.

## Low Priority Observations

### 9. SSH sessions skip host verification hardening
- **Impact:** NodeSSH connections accept the host key presented without additional verification, leaving room for man-in-the-middle risk on first use.
- **Evidence:**
  ```ts
  // src/modules/backup/services/ssh-backup-runner.ts
  27:     const sshConnectionOptions: any = {
  28:       host: sshConfig.host,
  29:       port: sshConfig.port || 22,
  30:       username: sshConfig.username,
  31:     };
  51:     const ssh = new NodeSSH();
  52:     await ssh.connect(sshConnectionOptions);
  ```
- **Notes:** Configure `hostVerifier`, known-hosts checks, or document the trust model for SSH targets.

### 10. Lack of SSH command timeouts/backpressure visibility
- **Impact:** Long-running SSH dumps rely solely on NodeSSH defaults; stalled network streams may hang indefinitely with no retry/backoff reporting beyond spinner logs.
- **Evidence:**
  ```ts
  // src/modules/backup/services/ssh-backup-runner.ts
  120:       await new Promise<void>((resolve, reject) => {
  121:         ssh.connection?.exec(remoteCommand, {}, (err, stream) => {
  ```
- **Notes:** Add explicit timeouts/heartbeat logging and expose progress metrics for large archive transfers.

## Additional Considerations
- Spinner-heavy logging interleaves with stdout/stderr, making automation difficult to parse; consider structured logging for CI usage.
- Backup and restore controllers close MongoDB clients but rely on callers to ensure `backupDir` has capacity; add checks for disk usage before large operations.
- SSH backups stream remote stdout into a local `.tmp` file before renaming; ensure local disks have sufficient headroom or provide streaming hooks to external storage.
- Consider documenting current limitations (SSH restore, ObjectId-only time filters) in README to set expectations until remediations land.
