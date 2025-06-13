/* eslint-disable quotes */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NodeSSH } from 'node-ssh';
import type { SSHConfig } from '../../types';
import { Logger } from '../../utils/logger';

export class SshService {
  constructor(private readonly logger: Logger) {}

  /**
   * Executes a command over SSH and streams the output to a file.
   * @param sshConfig - SSH connection configuration
   * @param command - Base command to execute (e.g., 'mongodump')
   * @param args - Command arguments
   * @param queryValue - Optional query value for mongodump
   * @param outputPath - Path to save the command output
   */
  async executeCommand(
    sshConfig: SSHConfig,
    command: string,
    args: string[],
    queryValue?: string,
    outputPath?: string,
  ): Promise<void> {
    const sshConnectionOptions: any = {
      host: sshConfig.host,
      port: sshConfig.port || 22,
      username: sshConfig.username,
    };

    if (sshConfig.password) {
      sshConnectionOptions.password = sshConfig.password;
    } else if (sshConfig.privateKey) {
      const privateKeyPath = sshConfig.privateKey.startsWith('~')
        ? path.join(os.homedir(), sshConfig.privateKey.substring(1))
        : sshConfig.privateKey;
      try {
        sshConnectionOptions.privateKey = fs.readFileSync(privateKeyPath, 'utf-8');
        if (sshConfig.passphrase) {
          sshConnectionOptions.passphrase = sshConfig.passphrase;
        }
      } catch (err: any) {
        throw new Error(`Failed to read private key at ${privateKeyPath}: ${err.message}`);
      }
    } else {
      throw new Error('SSH configuration must include either password or privateKey.');
    }

    const ssh = new NodeSSH();
    await ssh.connect(sshConnectionOptions);

    try {
      // Prepare command with arguments
      const remoteCommandParts = [command];
      args.forEach((arg) => {
        if (
          arg.includes(' ') ||
          arg.includes('"') ||
          arg.includes("'") ||
          arg.includes('$') ||
          arg.includes('=') ||
          arg.includes('{')
        ) {
          // eslint-disable-next-line prettier/prettier
          if (arg.startsWith("'") && arg.endsWith("'") && arg.includes('{')) {
            remoteCommandParts.push(arg);
          } else if (arg.startsWith('--password=') || arg.startsWith('--username=')) {
            const [key, ...valueParts] = arg.split('=');
            const value = valueParts.join('=');
            remoteCommandParts.push(`${key}='${value.replace(/['$`\\]/g, '\\$&')}'`);
          } else if (arg.startsWith('--uri=')) {
            remoteCommandParts.push(`${arg.replace(/^(--uri=)/, "$1'")}'`);
          } else {
            remoteCommandParts.push(`'${arg.replace(/['$`\\]/g, '\\$&')}'`);
          }
        } else {
          remoteCommandParts.push(arg);
        }
      });

      if (queryValue) {
        remoteCommandParts.push('--query', `'${queryValue}'`);
      }

      const remoteCommand = remoteCommandParts.join(' ');
      // Log the final mongodump command

      this.logger.info(`Running mongodump command: 
      -------------------
      ${remoteCommand}
      -------------------
      `);

      let stderr = '';

      if (!outputPath) {
        const { code, stdout, stderr: errOutput } = await ssh.execCommand(remoteCommand);
        stderr = errOutput;
        if (this.logger && stdout) {
          this.logger.info(`[SSH:mongodump][stdout] ${stdout.trim()}`);
        }
        if (this.logger && stderr) {
          this.logger.warn(`[SSH:mongodump][stderr] ${stderr.trim()}`);
        }
        if (code !== 0) {
          throw new Error(`Command failed with code ${code}. stderr: ${stderr}`);
        }
        return;
      }

      const fileStream = fs.createWriteStream(outputPath);
      let fileStreamError: Error | null = null;

      fileStream.on('error', (fsErr) => {
        fileStreamError = fsErr;
      });

      await new Promise<void>((resolve, reject) => {
        ssh.connection?.exec(remoteCommand, {}, (err, stream) => {
          if (err) {
            reject(new Error(`Failed to execute command: ${err.message}`));
            return;
          }

          stream.on('data', (data: Buffer) => {
            if (!fileStream.write(data)) {
              stream.pause();
              fileStream.once('drain', () => stream.resume());
            }
            // Don`t log stdout — it is binary data
          });

          stream.stderr.on('data', (data: Buffer) => {
            const msg = data.toString('utf8');
            stderr += msg;
            if (this.logger) {
              this.logger.warn(`[SSH:mongodump][stderr] ${msg.trim()}`);
            }
          });

          stream.on('close', (code: number) => {
            fileStream.end(() => {
              if (fileStreamError) {
                reject(fileStreamError);
                return;
              }
              if (code !== 0) {
                reject(new Error(`Command failed with code ${code}. stderr: ${stderr}`));
              } else {
                resolve();
              }
            });
          });

          stream.on('error', (streamErr: Error) => {
            reject(new Error(`Stream error: ${streamErr.message}`));
          });
        });
      });
    } finally {
      ssh.dispose();
    }
  }
}
