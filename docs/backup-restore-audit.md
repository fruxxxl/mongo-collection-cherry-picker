# Backup & Restore Workflow Audit

## Scope
- Review of backup orchestration (`backup-controller.ts`, `backup.service.ts`), dump argument builder (`domain/dump.ts`), strategy implementations (`local-backup-strategy.ts`, `ssh-backup-strategy.ts`, `ssh-backup-runner.ts`).
- Review of restore orchestration (`restore-controller.ts`, `restore.service.ts`).
- Focus on filtering logic, mongodump/mongorestore argument construction, SSH execution, metadata fidelity, and resource cleanup.

## High Priority Findings

### 1. Forced collection scans for every full backup
- **Impact:** `--forceTableScan` is appended whenever no explicit query is used. This disables index usage and forces full scans, heavily impacting performance on large collections and increasing load on primaries.
- **Evidence:**
  ```ts
  // src/modules/backup/domain/dump.ts
  136:     baseArgs.push('--gzip');
  137:     if (!queryValue) {
  138:       baseArgs.push('--forceTableScan');
  139:     }
  ```
- **Recommendation:** Default to indexed dumps and make table scans opt-in via config/flag.

### 2. Credentials leaked through command logging
- **Impact:** Logged mongodump/mongorestore commands contain `--username` and `--password`, exposing secrets in console output and log files.
- **Evidence:**
  ```ts
  // src/modules/backup/strategies/local-backup-strategy.ts
  26:     const commandString = `mongodump ${baseArgs.map((arg) => (arg.includes(' ') ? "${arg}" : arg)).join(' ')}`;
  27:     this.logger.info(`[${source.name}] Running mongodump command:\n      -------------------\n      ${commandString}`);
  ```
  ```ts
  // src/modules/backup/services/ssh-backup-runner.ts
  90:       this.logger.info(`Running mongodump command:\n      -------------------\n      ${remoteCommand}`);
  ```
  ```ts
  // src/modules/restore/services/restore.service.ts
  187:         commandStringForLog = `${mongorestorePath} ${directArgs.map((arg) => (arg.includes(' ') ? "${arg}" : arg)).join(' ')}`;
  188:         this.logger.info('Executing local mongorestore command:');
  189:         this.logger.snippet(commandStringForLog);
  ```
- **Recommendation:** Redact sensitive tokens (mask passwords or avoid logging full commands).

### 3. Quoted `--uri` arguments break spawned commands
- **Impact:** `spawn` passes literal arguments, so wrapping URIs in quotes results in `--uri="mongodb://..."`, which mongodump/mongorestore treats as including the quotes. This causes authentication/connection failures for URI-based configs and parity issues between local and SSH runs.
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
- **Recommendation:** Pass URIs without embedded quotes (e.g., `baseArgs.push(`--uri=${source.uri}`)` or split `['--uri', source.uri]`).

### 4. Restore to SSH targets unimplemented
- **Impact:** Disaster recovery to hosts only reachable via SSH is impossible. The flow logs a warning but continues, potentially signaling success despite no data restored.
- **Evidence:**
  ```ts
  // src/modules/restore/services/restore.service.ts
  100:       if (target.ssh) {
  101:         this.logger.warn('SSH restore not supported yet.');
  ```
- **Recommendation:** Either implement SSH restore parity (similar to backup) or fail-fast with actionable messaging.

## Medium Priority Findings

### 5. Metadata reflects user intent, not actual dump scope
- **Impact:** When include-mode falls back to backing up all collections (e.g., discovery failure), metadata still records the original `selectionMode` and collections, misleading restore planning.
- **Evidence:**
  ```ts
  // src/modules/backup/controllers/backup-controller.ts
  73:         selectionMode: intendedMode,
  76:         includedCollections: intendedMode === 'include' ? collectionsListForMetadata : undefined,
  77:         excludedCollections: intendedMode === 'exclude' ? collectionsListForMetadata : undefined,
  ```
  ```ts
  // src/modules/backup/controllers/backup-controller.ts
  312:           return { actualMode: 'all', actualSelected: [], actualExcluded: [] };
  334:         this.logger.warn(`[${contextLabel}] Fallback to backing up all collections.`);
  ```
- **Recommendation:** Persist the effective mode (`actualMode`, `actualExcluded`) into metadata for accurate restore context.

### 6. Time-filtered backups assume ObjectId `_id`
- **Impact:** The time filter converts timestamps into ObjectIds. Collections using UUID/string IDs trigger errors, aborting the backup.
- **Evidence:**
  ```ts
  // src/modules/backup/domain/dump.ts
  114:         const startObjectId = objectIdFromTimestamp(startTime);
  115:         queryValue = JSON.stringify({ _id: { $gte: { $oid: startObjectId } } });
  123:         this.logger.error(`Error generating ObjectId for time filter: ${e.message}`);
  124:         throw new Error('Failed to create time filter query.');
  ```
- **Recommendation:** Detect non-ObjectId IDs and either disable the filter with a warning or support custom filter fields.

### 7. Collection discovery latency with silent fallback
- **Impact:** Include-mode connects to MongoDB to list every collection (one-by-one operations on remote clusters are costly). If discovery fails, the app silently widens scope to include everything.
- **Evidence:**
  ```ts
  // src/modules/backup/controllers/backup-controller.ts
  304:         await this.mongoService.connect(source);
  305:         const allCollections = await this.mongoService.getCollections(source.database);
  307:         await this.mongoService.close();
  333:         this.logger.failSpinner(`[${contextLabel}] Failed to fetch collection list: ${error.message}`);
  334:         this.logger.warn(`[${contextLabel}] Fallback to backing up all collections.`);
  ```
- **Recommendation:** Surface collection discovery errors instead of auto-expanding scope; consider caching results per run.

### 8. Restore controller swallows errors
- **Impact:** `runRestore` logs the failure but does not rethrow, so CLI callers may exit with status 0 even when restore fails.
- **Evidence:**
  ```ts
  // src/modules/restore/controllers/restore-controller.ts
  80:     } catch (error: any) {
  82:         this.logger.failSpinner(`Restore operation failed: ${error.message}`);
  84:         this.logger.error(`✖ Restore operation failed: ${error.message}`);
  88:       }
  ```
- **Recommendation:** Propagate the error to upstream handlers to set exit codes and stop chained workflows.

### 9. MongoDBService reconnect cost during includes
- **Impact:** `getActualBackupParams` connects and closes the MongoDB client repeatedly; repeated include-mode backups incur full connection setup and tunnel lifecycle overhead each time.
- **Evidence:**
  ```ts
  // src/modules/backup/controllers/backup-controller.ts
  304:         await this.mongoService.connect(source);
  ...
  307:         await this.mongoService.close();
  ```
- **Recommendation:** Reuse the client across collection discovery and backup execution or cache collection lists when possible.

## Low Priority Observations

### 10. SSH host verification not enforced
- **Impact:** NodeSSH accepts presented host keys without additional verification, leaving room for MITM attacks in new connections.
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
- **Recommendation:** Integrate host key verification or document the trust requirement.

### 11. SSH stream lacks timeout/backpressure visibility
- **Impact:** Long-running SSH dumps rely on NodeSSH defaults. Network stalls may hang indefinitely without progress indicators or retries.
- **Evidence:**
  ```ts
  // src/modules/backup/services/ssh-backup-runner.ts
  120:       await new Promise<void>((resolve, reject) => {
  121:         ssh.connection?.exec(remoteCommand, {}, (err, stream) => {
  ```
- **Recommendation:** Add explicit timeouts, heartbeat logs, or retry logic for resilience.

### 12. SSH `.tmp` files require local disk headroom
- **Impact:** Remote dumps are streamed into `<file>.tmp` before renaming. Large archives can exhaust local disk without early checks.
- **Evidence:**
  ```ts
  // src/modules/backup/strategies/ssh-backup-strategy.ts
  28:     const tempFilePath = `${filePath}.tmp`;
  29:     baseArgs.push('--archive');
  32:       await this.sshService.executeCommand(... tempFilePath);
  ```
- **Recommendation:** Pre-flight disk space checks or allow piping to alternative storage.

## Additional Considerations
- Spinner-heavy logging interleaves with stdout/stderr, making automation and log scraping harder; consider structured logs for CI usage.
- No concurrency controls exist around backup/restore execution. Running multiple operations concurrently could contend for single shared config directories and spinners.
- Document current limitations (SSH restore, ObjectId-only time filters, forced table scans) in the README to set expectations until remediations ship.
