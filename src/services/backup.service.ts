/* eslint-disable quotes */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import { NodeSSH } from 'node-ssh';
import type { AppConfig, BackupMetadata, ConnectionConfig } from '../types';
import { formatFilename, getFormattedTimestamps, objectIdFromTimestamp } from '../utils/formatter';

/**
 * Handles the execution of mongodump command for creating MongoDB backups.
 * Supports both direct database connections and connections via SSH tunnel.
 */
export class BackupService {
  private config: AppConfig;

  /**
   * Creates an instance of BackupService.
   * @param config - The application configuration.
   */
  constructor(config: AppConfig) {
    this.config = config;
  }

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

    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
      console.log(`Created backup directory: ${backupDir}`);
    }

    console.log(`\nBackup archive will be saved to: ${filePath}`);

    const baseArgs: string[] = [];

    // --- Connection Arguments ---
    if (source.ssh) {
      // SSH Execution: Ignore URI, use separate fields for mongodump on remote host
      console.log(`[${source.name}] SSH mode detected. Building mongodump args from separate fields.`);

      // Важно: Для SSH mongodump должен подключаться к MongoDB на удаленной машине.
      // Хост и порт MongoDB могут отличаться от хоста/порта SSH.
      // Используем поля из конфига source, а не source.ssh для MongoDB.
      if (!source.database) {
        throw new Error(`[${source.name}] Database name ('database') is required in config for SSH backup.`);
      }
      baseArgs.push(`--db=${source.database}`);

      // Пытаемся извлечь хост/порт из URI, если отдельные поля не заданы
      let mongoHost = source.host;
      let mongoPort = source.port;
      const requiresAuthArgs = true; // Assume we need user/pass unless URI parsing fails specifically

      if (!mongoHost && source.uri) {
        try {
          const parsedUri = new URL(source.uri);
          // Простой парсинг, может не покрыть все случаи replica set URI
          mongoHost = parsedUri.hostname; // Или parsedUri.host если включает порт
          mongoPort = parseInt(parsedUri.port, 10) || undefined; // Используем порт из URI если есть
          console.log(
            `[${source.name}] Extracted MongoDB host/port from URI for SSH: ${mongoHost}:${mongoPort || 'default'}`,
          );
          // Если URI есть, предполагаем, что mongodump сам разберется с auth из него,
          // но это рискованно. Лучше требовать явные поля.
          // Пока оставим requiresAuthArgs = true
        } catch (e) {
          console.warn(
            `[${source.name}] Could not parse MongoDB host/port from URI. Please define 'host' and 'port' explicitly in config for SSH backup.`,
          );
        }
      }

      if (mongoHost) baseArgs.push(`--host=${mongoHost}`);
      if (mongoPort) baseArgs.push(`--port=${mongoPort}`);

      // Добавляем аутентификацию, если она есть в конфиге
      if (source.username) baseArgs.push(`--username=${source.username}`);
      else if (requiresAuthArgs) console.warn(`[${source.name}] SSH Backup: 'username' not found in config.`);

      if (source.password) baseArgs.push(`--password=${source.password}`);
      else if (requiresAuthArgs && source.username)
        console.warn(`[${source.name}] SSH Backup: 'password' not found in config for user ${source.username}.`);

      const authDb = source.authenticationDatabase || source.authSource; // Prefer explicit fields
      if (authDb) {
        baseArgs.push(`--authenticationDatabase=${authDb}`);
      } else if (requiresAuthArgs && source.username) {
        // Пытаемся извлечь из URI как fallback
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
          console.log(`[${source.name}] Extracted authSource from URI: ${authSourceFromUri}`);
        } else {
          console.warn(
            `[${source.name}] SSH Backup: 'authenticationDatabase' or 'authSource' not found in config or URI for user ${source.username}. Assuming 'admin' or target db might work.`,
          );
          // Можно добавить базу по умолчанию, например 'admin', если не найдено
          // baseArgs.push(`--authenticationDatabase=admin`);
        }
      }
    } else {
      // Local Execution: Use URI if available, otherwise separate fields
      if (source.uri) {
        baseArgs.push(`--uri="${source.uri}"`);

        baseArgs.push(`--db=${source.database}`);
      } else {
        // Fallback to separate fields if no URI
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
        const authDb = source.authenticationDatabase || source.authSource || source.database; // Default to target db if not specified
        if (authDb) baseArgs.push(`--authenticationDatabase=${authDb}`);
      }
    }
    // --- End Connection Arguments ---

    // --- Filtering Arguments ---
    let queryValue: string | undefined = undefined;

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
        console.log(
          `Applying time filter to collection "${collectionName}": including documents with _id >= ${startObjectId} (time >= ${startTime.toISOString()})`,
        );
      } catch (e) {
        console.error(`Error generating ObjectId for time filter: ${e instanceof Error ? e.message : String(e)}`);
        throw new Error('Failed to create time filter query.');
      }
    } else {
      if (mode === 'exclude' && excludedCollections.length > 0) {
        excludedCollections.forEach((coll) => baseArgs.push('--excludeCollection', coll));
        console.log(`[${source.name}] Backup mode: excluding ${excludedCollections.length} collection(s)`);
      } else {
        console.log(`[${source.name}] Backup mode: all collections`);
      }
    }
    // --- End Filtering Arguments ---

    baseArgs.push('--gzip');

    const mongodumpPath = this.config.mongodumpPath || 'mongodump';
    let commandStringForLog = '';

    try {
      if (source.ssh) {
        // --- SSH Execution with NodeSSH ---
        console.log(`Executing mongodump via SSH to ${source.ssh.host} using node-ssh...`);
        const ssh = new NodeSSH();

        const remoteArgs = [...baseArgs];
        if (queryValue) {
          // node-ssh's execCommand handles shell escaping better, but be cautious with complex queries
          // Ensure the outer quotes are suitable for the remote shell
          remoteArgs.push('--query', `'${queryValue}'`);
        }
        remoteArgs.push('--archive'); // Output to stdout

        const remoteCommandParts = [mongodumpPath];
        remoteArgs.forEach((arg) => {
          // Basic heuristic for quoting arguments for the remote shell
          if (
            arg.includes(' ') ||
            arg.includes('"') ||
            arg.includes("'") ||
            arg.includes('$') ||
            arg.includes('=') ||
            arg.includes('{')
          ) {
            // If it looks like a JSON query, keep the single quotes.
            if (arg.startsWith("'") && arg.endsWith("'") && arg.includes('{')) {
              remoteCommandParts.push(arg);
              // If it's a password argument, quote it carefully.
            } else if (arg.startsWith('--password=') || arg.startsWith('--username=')) {
              const [key, ...valueParts] = arg.split('=');
              const value = valueParts.join('=');
              // Use double quotes and escape internal double quotes and dollars/backticks if any
              remoteCommandParts.push(`${key}="${value.replace(/["$`\\]/g, '\\$&')}"`);
            } else if (arg.startsWith('--uri="')) {
              remoteCommandParts.push(arg); // Assume URI is already quoted if needed
            } else {
              // General case: double quote and escape internal double quotes/dollars/backticks
              remoteCommandParts.push(`"${arg.replace(/["$`\\]/g, '\\$&')}"`);
            }
          } else {
            remoteCommandParts.push(arg);
          }
        });
        const remoteCommand = remoteCommandParts.join(' ');

        commandStringForLog = `ssh ... "${remoteCommand}" > ${filePath}`; // For logging purposes
        console.log(
          `Prepared remote mongodump command for node-ssh:\n${remoteCommand.replace(/--password="[^"]+"/, '--password="***"')}\n(Output will be piped locally to ${path.basename(filePath)})`,
        );

        const sshConnectionOptions: Parameters<NodeSSH['connect']>[0] = {
          host: source.ssh.host,
          port: source.ssh.port || 22,
          username: source.ssh.username,
        };

        if (source.ssh.password) {
          console.log(`[${source.name}] Using SSH password authentication.`);
          sshConnectionOptions.password = source.ssh.password;
        } else if (source.ssh.privateKey) {
          console.log(`[${source.name}] Using SSH private key authentication.`);
          const privateKeyPath = source.ssh.privateKey.startsWith('~')
            ? path.join(os.homedir(), source.ssh.privateKey.substring(1))
            : source.ssh.privateKey;
          try {
            sshConnectionOptions.privateKey = fs.readFileSync(privateKeyPath, 'utf-8');
            if (source.ssh.passphrase) {
              sshConnectionOptions.passphrase = source.ssh.passphrase;
            }
          } catch (err: any) {
            throw new Error(`Failed to read private key at ${privateKeyPath}: ${err.message}`);
          }
        } else {
          throw new Error(`[${source.name}] SSH configuration must include either 'password' or 'privateKey'.`);
        }

        const fileStream = fs.createWriteStream(filePath);
        let fileStreamError: Error | null = null;

        fileStream.on('error', (fsErr) => {
          console.error(`Error writing backup file ${filePath}:`, fsErr);
          fileStreamError = fsErr;
          // Attempt to signal the SSH connection to stop, though it might be too late
          if (ssh.isConnected()) {
            // node-ssh doesn't have a direct way to cancel execCommand stream easily.
            // Disposing might abort the process.
            ssh.dispose();
          }
        });

        try {
          await ssh.connect(sshConnectionOptions);
          console.log('SSH connection established.');

          console.log('Executing remote mongodump command via node-ssh (streaming with execCommand)...');

          // Wrap execCommand in a Promise for proper async handling with streams
          await new Promise<void>((resolve, reject) => {
            let stderrOutput = '';
            let commandExitCode: number | null = null;

            ssh
              .execCommand(remoteCommand, {
                // cwd: '/tmp',
                execOptions: { pty: false },
                onStdout: (chunk: Buffer) => {
                  if (!fileStream.write(chunk)) {
                    console.log('[Debug] fileStream write returned false (backpressure)');
                  }
                },
                onStderr: (chunk: Buffer) => {
                  const errorChunk = chunk.toString('utf8');
                  console.warn('SSH/mongodump stderr:', errorChunk.trim());
                  stderrOutput += errorChunk;
                },
                // Attempt to capture the exit code if possible, though this isn't standard for execCommand
                // Usually, execCommand resolves with the full result after completion.
                // We might need a different approach if this doesn't work.
              })
              .then((result: { stdout: string; stderr: string; code: number | null }) => {
                // This block is called AFTER the command finishes and all streams close.
                // result.stdout/stderr contain the *full* buffered output here.
                console.log('Remote command finished execution (execCommand).');
                commandExitCode = result.code;
                stderrOutput = result.stderr; // Update stderr with the final buffered value

                // Ensure file stream finishes writing any final data (might be redundant if onStdout captured everything)
                fileStream.end(() => {
                  if (fileStreamError) {
                    console.error('Error occurred during file writing, rejecting.');
                    reject(fileStreamError);
                    return;
                  }

                  // Check if code is not 0 (treat null as non-zero)
                  if (commandExitCode !== 0) {
                    const exitReason =
                      commandExitCode === null ? 'terminated by signal' : `exited with code ${commandExitCode}`;
                    const errorMsg = `Remote mongodump command failed (${exitReason}). Stderr: ${stderrOutput || 'N/A'}`;
                    console.error(errorMsg);
                    reject(new Error(errorMsg));
                  } else {
                    console.log('File stream finished writing successfully.');
                    if (stderrOutput) {
                      console.warn('[${source.name}] node-ssh execution completed with stderr output (see above).');
                    } else {
                      console.log('[${source.name}] node-ssh execution completed successfully.');
                    }
                    resolve(); // Resolve the promise on successful completion
                  }
                });
              })
              .catch((error) => {
                // Catches errors from ssh.execCommand() itself
                console.error('Error during ssh.execCommand execution:', error);
                fileStream.end(); // Close file stream on error
                reject(error);
              });

            // Handle errors on the file stream itself
            fileStream.on('error', (fsErr) => {
              if (!fileStreamError) {
                // Avoid rejecting twice
                console.error('File stream encountered error during operation:', fsErr);
                fileStreamError = fsErr; // Set the flag
                // We might want to reject the promise here directly, but the .then() block handles cleanup
                // Consider if immediate rejection is needed or if letting .then() handle it is sufficient
              }
            });
          }); // End of new Promise
        } catch (error: any) {
          // Catch connection errors or execCommand errors
          console.error(`Error during node-ssh execution:`, error);
          throw error; // Re-throw the error to be caught by the outer try-catch
        } finally {
          // Ensure resources are cleaned up
          if (fileStream && !fileStream.closed) {
            fileStream.end(); // Ensure file stream is closed
          }
          if (ssh.isConnected()) {
            console.log('Disconnecting SSH...');
            ssh.dispose();
          }
        }

        // --- End SSH Execution with NodeSSH ---
      } else {
        // --- Local Execution ---
        const directArgs = [...baseArgs];
        if (queryValue) {
          directArgs.push('--query', queryValue);
        }
        directArgs.push(`--archive=${filePath}`);

        commandStringForLog = `${mongodumpPath} ${directArgs.map((arg) => (arg.includes(' ') || arg.includes("'") || arg.includes('"') ? `"${arg.replace(/"/g, '\\"')}"` : arg)).join(' ')}`;
        console.log(`\nExecuting local mongodump command:\n${commandStringForLog}\n`);

        const dumpProcess = spawn(mongodumpPath, directArgs, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });

        let errorOutput = '';
        dumpProcess.stderr.on('data', (data) => {
          const errorChunk = data.toString();
          console.warn(`mongodump: ${errorChunk.trim()}`);
          errorOutput += errorChunk;
        });

        const exitCode = await new Promise<number>((resolve, reject) => {
          dumpProcess.on('close', resolve);
          dumpProcess.on('error', (err) => {
            console.error(`Failed to start local mongodump process: ${err.message}`);
            reject(new Error(`Failed to start local mongodump process: ${err.message}`));
          });
        });

        if (exitCode !== 0) {
          throw new Error(`Local mongodump finished with exit code ${exitCode}. Stderr: ${errorOutput}`);
        }
        console.log(`[${source.name}] Local mongodump process completed successfully.`);
      }

      return filePath;
    } catch (error: any) {
      console.error(`\n✖ Error creating backup: ${error.message}`);
      // commandStringForLog might not be defined if error happened before it was set
      if (commandStringForLog) {
        console.error(`Failed command (approximate): ${commandStringForLog}`);
      }
      // Ensure cleanup happens even if error occurs during node-ssh block or local execution
      if (fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
          console.log(`Cleaned up incomplete backup file: ${filePath}`);
        } catch (cleanupError: any) {
          console.error(`Failed to cleanup incomplete backup file ${filePath}: ${cleanupError.message}`);
        }
      }
      throw error; // Re-throw the original error
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
      throw new Error(`Metadata file not found: ${metadataPath}`);
    }
    try {
      const metadataContent = fs.readFileSync(metadataPath, 'utf-8');
      const metadata = JSON.parse(metadataContent) as BackupMetadata;
      if (!metadata.source || !metadata.timestamp || !metadata.archivePath) {
        throw new Error('Metadata file is missing required fields (source, timestamp, archivePath).');
      }
      metadata.archivePath = path.basename(metadata.archivePath);
      return metadata;
    } catch (error: any) {
      throw new Error(`Failed to load or parse metadata file ${metadataPath}: ${error.message}`);
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
          } catch {
            return { name: file, time: 0 };
          }
        })
        .sort((a, b) => b.time - a.time)
        .map((file) => file.name);
    } catch (error: any) {
      console.error(`Error reading backup directory ${backupDir}: ${error.message}`);
      return [];
    }
  }
}
