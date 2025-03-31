import { Client } from 'ssh2';
import { SSHConfig } from '../types';
import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';

export class SSHService {
  private client: Client;
  private server: net.Server | null = null;
  private config: SSHConfig;

  constructor(config: SSHConfig) {
    this.client = new Client();
    this.config = config;
  }

  async createTunnel(): Promise<string> {
    return new Promise((resolve, reject) => {
      // Expand tilde in private key path

      const privateKeyPath = this.config.privateKey.replace(
        /^~/,
        process.env.HOME || process.env.USERPROFILE || ''
      );
      const privateKey = fs.readFileSync(path.resolve(privateKeyPath));

      this.client.on('ready', () => {
        this.server = net.createServer((sock) => {
          this.client.forwardOut(
            '127.0.0.1',
            this.config.localPort,
            this.config.remoteHost,
            this.config.remotePort,
            (err, stream) => {
              if (err) {
                sock.end();
                return;
              }

              sock.pipe(stream);
              stream.pipe(sock);
            }
          );
        });

        this.server.listen(this.config.localPort, '127.0.0.1', () => {
          resolve(`mongodb://127.0.0.1:${this.config.localPort}`);
        });
      });

      this.client.on('error', (err) => {
        reject(err);
      });

      this.client.connect({
        host: this.config.host,
        port: this.config.port,
        username: this.config.username,
        privateKey,
        passphrase: this.config.passphrase
      });
    });
  }

  closeTunnel(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    this.client.end();
  }
}
