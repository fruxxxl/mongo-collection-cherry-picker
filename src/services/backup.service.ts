/* eslint-disable quotes */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import { NodeSSH } from 'node-ssh';
import type { AppConfig, BackupMetadata, ConnectionConfig } from '../types';
import { formatFilename, getFormattedTimestamps, objectIdFromTimestamp } from '../utils/formatter';
import { Logger } from '../utils/logger';

/**
 * Handles the execution of mongodump command for creating MongoDB backups.
 * Supports both direct database connections and connections via SSH tunnel.
 */
export class BackupService {
  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  /**
   * Executes the mongodump command to create a backup archive (.gz).
   * Determines whether to run mongodump locally or remotely via SSH based on the source configuration.
   * Handles collection filtering based on provided arguments.
   *
   * @param source - The configuration of the source MongoDB connection.
   * @param selectedCollections - An array of collection names for the `--collection` flag (should be empty if mode is 'exclude' or 'all').
   * @param excludedCollections - An array of collection names for the `--excludeCollection` flag (used when mode is 'exclude').
   * @param mode - Specifies the effective mode for the mongodump command ('all', 'include', 'exclude').
   * @param startTime - Optional start time to filter documents using --query on _id.
   * @returns A promise that resolves with the absolute path to the created backup archive file.
   * @throws An error if the backup process fails.
   */
  async createBackup(
    source: ConnectionConfig,
    selectedCollections: string[],
    excludedCollections: string[],
    mode: 'all' | 'include' | 'exclude',
    startTime?: Date,
  ): Promise<string> {
    const now = new Date();
    const { date, time, datetime } = getFormattedTimestamps(now);

    const filename = formatFilename(
      this.config.filenameFormat || 'backup_{datetime}_{source}.gz',
      date,
      time,
      datetime,
      source.name,
    );
    const backupDir = path.resolve(this.config.backupDir);
    const filePath = path.join(backupDir, filename);

    this.logger.startSpinner('Starting backup process...');

    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
      this.logger.succeedSpinner(`Created backup directory: ${backupDir}`);
    }

    this.logger.updateSpinner(`Backup archive will be saved to: ${filePath}`);

    const baseArgs: string[] = [];
    let queryValue: string | undefined = undefined;

    // --- Connection Arguments ---
    if (source.ssh) {
      // SSH Execution: Ignore URI, use separate fields for mongodump on remote host
      this.logger.debug(`[${source.name}] SSH mode detected. Building mongodump args from separate fields.`);

      if (!source.database) {
        throw new Error(`[${source.name}] Database name ('database') is required in config for SSH backup.`);
      }
      baseArgs.push(`--db=${source.database}`);

      let mongoHost = source.host;
      let mongoPort = source.port;

      if (!mongoHost && source.uri) {
        try {
          const parsedUri = new URL(source.uri);
          mongoHost = parsedUri.hostname;
          mongoPort = parseInt(parsedUri.port, 10) || undefined;
          this.logger.debug(
            `[${source.name}] Extracted MongoDB host/port from URI for SSH: ${mongoHost}:${mongoPort || 'default'}`,
          );
        } catch (e) {
          this.logger.warn(
            `[${source.name}] Could not parse MongoDB host/port from URI. Please define 'host' and 'port' explicitly in config for SSH backup.`,
          );
        }
      }

      if (mongoHost) baseArgs.push(`--host=${mongoHost}`);
      if (mongoPort) baseArgs.push(`--port=${mongoPort}`);

      if (source.username) baseArgs.push(`--username=${source.username}`);
      else this.logger.debug(`[${source.name}] SSH Backup: 'username' not found in config.`);

      if (source.password) baseArgs.push(`--password=${source.password}`);
      else if (source.username)
        this.logger.warn(`[${source.name}] SSH Backup: 'password' not found in config for user ${source.username}.`);

      const authDb = source.authenticationDatabase || source.authSource;
      if (authDb) {
        baseArgs.push(`--authenticationDatabase=${authDb}`);
      } else if (source.username) {
        let authSourceFromUri: string | null = null;
        if (source.uri) {
          try {
            const parsedUri = new URL(source.uri);
            authSourceFromUri = parsedUri.searchParams.get('authSource');
          } catch {
            /* ignore parsing error */
          }
        }
        if (authSourceFromUri) {
          baseArgs.push(`--authenticationDatabase=${authSourceFromUri}`);
          this.logger.debug(`[${source.name}] Extracted authSource from URI: ${authSourceFromUri}`);
        } else {
          this.logger.warn(
            `[${source.name}] SSH Backup: 'authenticationDatabase' or 'authSource' not found in config or URI for user ${source.username}. Assuming 'admin' or target db might work.`,
          );
        }
      }
    } else {
      // Local Execution: Use URI if available, otherwise separate fields
      if (source.uri) {
        baseArgs.push(`--uri="${source.uri}"`);
        if (source.database) {
          baseArgs.push(`--db=${source.database}`);
        }
      } else {
        if (!source.database) {
          throw new Error(
            `[${source.name}] Database name ('database') is required for local backup if URI is not provided.`,
          );
        }
        baseArgs.push(`--db=${source.database}`);
        if (source.host) baseArgs.push(`--host=${source.host}`);
        if (source.port) baseArgs.push(`--port=${source.port}`);
        if (source.username) baseArgs.push(`--username=${source.username}`);
        if (source.password) baseArgs.push(`--password=${source.password}`);
        const authDb = source.authenticationDatabase || source.authSource || source.database;
        if (authDb) baseArgs.push(`--authenticationDatabase=${authDb}`);
      }
    }
    // --- End Connection Arguments ---

    // --- Filtering Arguments ---
    if (startTime) {
      if (mode !== 'include' || selectedCollections.length !== 1) {
        throw new Error(
          'Internal error: startTime provided but mode is not "include" or selectedCollections count is not 1.',
        );
      }
      const collectionName = selectedCollections[0];
      baseArgs.push('--collection', collectionName);
      try {
        const startObjectId = objectIdFromTimestamp(startTime);
        queryValue = JSON.stringify({ _id: { $gte: { $oid: startObjectId } } });
        this.logger.info(
          `Applying time filter to collection "${collectionName}": including documents with _id >= ${startObjectId} (time >= ${startTime.toISOString()})`,
        );
      } catch (e: any) {
        this.logger.error(`Error generating ObjectId for time filter: ${e.message}`);
        throw new Error('Failed to create time filter query.');
      }
    } else {
      if (mode === 'exclude' && excludedCollections.length > 0) {
        excludedCollections.forEach((coll) => baseArgs.push('--excludeCollection', coll));
        this.logger.info(`[${source.name}] Backup mode: excluding ${excludedCollections.length} collection(s)`);
      } else {
        this.logger.info(`[${source.name}] Backup mode: all collections`);
      }
    }
    // --- End Filtering Arguments ---

    baseArgs.push('--gzip');
    if (!queryValue) {
      baseArgs.push('--forceTableScan');
    }

    const mongodumpPath = this.config.mongodumpPath || 'mongodump';
    let commandStringForLog = '';

    try {
      if (source.ssh) {
        // --- SSH Execution with NodeSSH ---
        this.logger.updateSpinner(`Executing mongodump via SSH to ${source.ssh.host} using node-ssh...`);
        const ssh = new NodeSSH();

        const remoteArgs = [...baseArgs];
        if (queryValue) {
          remoteArgs.push('--query', `'${queryValue}'`);
        }
        remoteArgs.push('--archive'); // Output to stdout

        const remoteCommandParts = [mongodumpPath];
        remoteArgs.forEach((arg) => {
          if (
            arg.includes(' ') ||
            arg.includes('"') ||
            arg.includes("'") ||
            arg.includes('$') ||
            arg.includes('=') ||
            arg.includes('{')
          ) {
            if (arg.startsWith("'") && arg.endsWith("'") && arg.includes('{')) {
              remoteCommandParts.push(arg);
            } else if (arg.startsWith('--password=') || arg.startsWith('--username=')) {
              const [key, ...valueParts] = arg.split('=');
              const value = valueParts.join('=');
              remoteCommandParts.push(`${key}="${value.replace(/["$`\\]/g, '\\$&')}"`);
            } else if (arg.startsWith('--uri="')) {
              remoteCommandParts.push(arg);
            } else {
              remoteCommandParts.push(`"${arg.replace(/["$`\\]/g, '\\$&')}"`);
            }
          } else {
            remoteCommandParts.push(arg);
          }
        });
        const remoteCommand = remoteCommandParts.join(' ');

        commandStringForLog = `ssh ... "${remoteCommand}" > ${filePath}`; // For logging purposes
        this.logger.updateSpinner(
          `Prepared remote mongodump command for node-ssh: (Output will be piped locally to ${path.basename(filePath)})`,
        );
        this.logger.snippet(remoteCommand);

        const sshConnectionOptions: Parameters<NodeSSH['connect']>[0] = {
          host: source.ssh.host,
          port: source.ssh.port || 22,
          username: source.ssh.username,
        };

        if (source.ssh.password) {
          this.logger.info(`[${source.name}] Using SSH password authentication.`);
          sshConnectionOptions.password = source.ssh.password;
        } else if (source.ssh.privateKey) {
          this.logger.info(`[${source.name}] Using SSH private key authentication.`);
          const privateKeyPath = source.ssh.privateKey.startsWith('~')
            ? path.join(os.homedir(), source.ssh.privateKey.substring(1))
            : source.ssh.privateKey;
          try {
            sshConnectionOptions.privateKey = fs.readFileSync(privateKeyPath, 'utf-8');
            if (source.ssh.passphrase) {
              sshConnectionOptions.passphrase = source.ssh.passphrase;
            }
          } catch (err: any) {
            this.logger.error(`Failed to read private key at ${privateKeyPath}: ${err}`);
            throw new Error(`Failed to read private key at ${privateKeyPath}.`);
          }
        } else {
          throw new Error(`[${source.name}] SSH configuration must include either 'password' or 'privateKey'.`);
        }

        const fileStream = fs.createWriteStream(filePath);
        let fileStreamError: Error | null = null;

        fileStream.on('error', (fsErr) => {
          this.logger.error(`Error writing backup file ${filePath}: ${fsErr}`);
          fileStreamError = fsErr;
          if (ssh.isConnected()) {
            ssh.dispose();
          }
        });

        try {
          this.logger.updateSpinner('Establishing SSH connection...');
          await ssh.connect(sshConnectionOptions);
          this.logger.succeedSpinner('SSH connection established.');

          this.logger.updateSpinner('Executing remote mongodump command via node-ssh (streaming with execCommand)...');

          await new Promise<void>((resolve, reject) => {
            let stderrOutput = '';
            let commandExitCode: number | null = null;

            ssh
              .execCommand(remoteCommand, {
                execOptions: { pty: false },
                onStdout: (chunk: Buffer) => {
                  if (!fileStream.write(chunk)) {
                    this.logger.debug('[Debug] fileStream write returned false (backpressure)');
                  }
                },
                onStderr: (chunk: Buffer) => {
                  const errorChunk = chunk.toString('utf8');
                  this.logger.warn('SSH/mongodump stderr: ' + errorChunk.trim());
                  stderrOutput += errorChunk;
                },
              })
              .then((result: { stdout: string; stderr: string; code: number | null }) => {
                this.logger.succeedSpinner('Remote command finished execution (execCommand).');
                commandExitCode = result.code;
                stderrOutput = result.stderr;
                if (stderrOutput) {
                  this.logger.warn('Final SSH/mongodump stderr:', stderrOutput.trim());
                }

                fileStream.end(() => {
                  if (fileStreamError) {
                    this.logger.error('Error occurred during file writing, rejecting.');
                    reject(fileStreamError);
                    return;
                  }

                  if (commandExitCode !== 0) {
                    const exitReason =
                      commandExitCode === null ? 'terminated by signal' : `exited with code ${commandExitCode}`;
                    const errorMsg = `Remote mongodump command failed (${exitReason}). Stderr: ${stderrOutput || 'N/A'}`;
                    this.logger.error(errorMsg);
                    reject(new Error(errorMsg));
                  } else {
                    this.logger.succeedSpinner('File stream finished writing successfully.');
                    if (stderrOutput) {
                      this.logger.warn(`[${source.name}] node-ssh execution completed with stderr output (see above).`);
                    } else {
                      this.logger.succeedSpinner(`[${source.name}] node-ssh execution completed successfully.`);
                    }
                    resolve();
                  }
                });
              })
              .catch((error) => {
                this.logger.error('Error during ssh.execCommand execution:', error);
                fileStream.end();
                reject(error);
              });

            fileStream.on('error', (fsErr) => {
              if (!fileStreamError) {
                this.logger.error('File stream encountered error during operation:', fsErr);
                fileStreamError = fsErr;
              }
            });
          }); // End of new Promise
        } catch (error: any) {
          this.logger.error(`Error during node-ssh execution: ${error}`);
          throw error;
        } finally {
          if (fileStream && !fileStream.closed) {
            fileStream.end();
          }
          if (ssh.isConnected()) {
            this.logger.info('Disconnecting SSH...');
            ssh.dispose();
          }
        }
      } else {
        // --- Local Execution ---
        const directArgs = [...baseArgs];
        if (queryValue) {
          directArgs.push('--query', queryValue);
        }
        directArgs.push(`--archive=${filePath}`);

        commandStringForLog = `${mongodumpPath} ${directArgs.map((arg) => (arg.includes(' ') || arg.includes("'") || arg.includes('"') ? `"${arg.replace(/"/g, '\\"')}"` : arg)).join(' ')}`;
        this.logger.updateSpinner(`Executing local mongodump command:`);
        this.logger.snippet(commandStringForLog);

        const dumpProcess = spawn(mongodumpPath, directArgs, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });

        let errorOutput = '';
        dumpProcess.stderr.on('data', (data) => {
          const errorChunk = data.toString();
          this.logger.warn(`mongodump stderr: ${errorChunk.trim()}`);
          errorOutput += errorChunk;
        });

        const exitCode = await new Promise<number>((resolve, reject) => {
          dumpProcess.on('close', resolve);
          dumpProcess.on('error', (err) => {
            this.logger.error(`Failed to start local mongodump process: ${err.message}`);
            reject(new Error(`Failed to start local mongodump process: ${err.message}`));
          });
        });

        if (exitCode !== 0) {
          const errorMsg = `Local mongodump finished with exit code ${exitCode}. Stderr: ${errorOutput}`;
          this.logger.error(errorMsg);
          throw new Error(errorMsg);
        }
        this.logger.succeedSpinner(`[${source.name}] Local mongodump process completed successfully.`);
      }

      return filePath;
    } catch (error: any) {
      const errorMsg = `Error creating backup for ${source.name}: ${error.message}`;
      this.logger.error(errorMsg);
      if (commandStringForLog) {
        this.logger.debug(`Failed command (approximate): ${commandStringForLog}`);
      }
      if (fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
          this.logger.succeedSpinner(`Cleaned up incomplete backup file: ${filePath}`);
        } catch (cleanupError: any) {
          this.logger.failSpinner(`Failed to cleanup incomplete backup file ${filePath}: ${cleanupError.message}`);
        }
      }
      throw new Error(`Backup failed for ${source.name}.`);
    } finally {
      this.logger.stopSpinner();
    }
  }

  /**
   * Loads backup metadata from the .json file corresponding to a backup archive.
   * @param backupFilename - The filename of the backup archive (e.g., backup_....gz).
   * @returns The parsed BackupMetadata object.
   * @throws An error if the metadata file is not found or cannot be parsed.
   */
  loadBackupMetadata(backupFilename: string): BackupMetadata {
    const metadataPath = path.join(this.config.backupDir, `${backupFilename}.json`);
    if (!fs.existsSync(metadataPath)) {
      this.logger.warn(`Metadata file not found: ${metadataPath}`);
      throw new Error(`Metadata file not found: ${metadataPath}`);
    }
    try {
      const metadataContent = fs.readFileSync(metadataPath, 'utf-8');
      const metadata = JSON.parse(metadataContent) as BackupMetadata;
      if (!metadata.source || !metadata.timestamp || !metadata.archivePath) {
        this.logger.error(`Metadata file ${metadataPath} is missing required fields.`);
        throw new Error('Metadata file is missing required fields (source, timestamp, archivePath).');
      }
      metadata.archivePath = path.basename(metadata.archivePath);
      return metadata;
    } catch (error: any) {
      this.logger.error(`Failed to load or parse metadata file ${metadataPath}: ${error.message}`);
      throw new Error(`Failed to load or parse metadata file ${metadataPath}.`);
    }
  }

  /**
   * Lists backup archive files (.gz) in the backup directory, sorted newest first.
   * @returns An array of backup filenames.
   */
  getBackupFiles(): string[] {
    const backupDir = path.resolve(this.config.backupDir);
    if (!fs.existsSync(backupDir)) {
      return [];
    }
    try {
      const files = fs.readdirSync(backupDir);
      return files
        .filter((file) => file.endsWith('.gz') && !file.startsWith('.'))
        .map((file) => {
          try {
            return { name: file, time: fs.statSync(path.join(backupDir, file)).mtime.getTime() };
          } catch (e: any) {
            this.logger.warn(`Could not stat file ${file} in backup dir: ${e.message}`);
            return { name: file, time: 0 };
          }
        })
        .sort((a, b) => b.time - a.time)
        .map((file) => file.name);
    } catch (error: any) {
      this.logger.error(`Error reading backup directory ${backupDir}: ${error.message}`);
      return [];
    }
  }
}
