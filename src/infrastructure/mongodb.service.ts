import { MongoClient, Db, ListCollectionsCursor } from 'mongodb';

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { Logger } from '@infrastructure/logger';
import { createTunnel } from 'tunnel-ssh';
import type { Server } from 'net';
import { parseMongoUri } from '@utils/parse-mongo-uri';
import { ConnectionConfig, SSHConfig } from '@ts-types/mixed';

/**
 * Provides services for connecting to MongoDB instances,
 * including handling connections via SSH tunnels.
 */
export class MongoDBService {
  private client: MongoClient | null = null;
  private sshTunnelServer: Server | null = null;

  /**
   * Creates an instance of MongoDBService.
   * @param logger - The logger service instance.
   */
  constructor(private readonly logger: Logger) {}

  /**
   * Establishes a connection to a MongoDB instance based on the provided configuration.
   * Handles direct connections and connections via SSH tunnel automatically.
   * Stores the active client connection internally.
   *
   * @param connectionConfig - The configuration for the specific MongoDB connection.
   * @returns A promise that resolves when the connection is established.
   * @throws An error if the connection fails.
   */
  async connect(connectionConfig: ConnectionConfig): Promise<void> {
    if (this.client) {
      this.logger.warn(
        `[${connectionConfig.name}] Already connected. Closing existing connection before reconnecting.`,
      );
      await this.close();
    }

    try {
      if (connectionConfig.ssh) {
        this.client = await this.connectWithTunnel(connectionConfig);
        this.logger.info(`[${connectionConfig.name}] Connection successfully established via SSH tunnel.`);
      } else {
        const uri = this.buildMongoUri(connectionConfig);
        this.logger.info(
          `[${connectionConfig.name}] Connecting directly to MongoDB with URI: ${uri.replace(/:([^:@\/]+)@/, ':<password>@')}`,
        );
        this.client = await MongoClient.connect(uri);
        this.logger.info(`[${connectionConfig.name}] Direct connection successfully established.`);
      }
    } catch (error: any) {
      this.logger.error(`[${connectionConfig.name}] Connection failed in connect method: ${error}`);
      if (this.sshTunnelServer) {
        this.logger.warn(`[${connectionConfig.name}] Closing SSH tunnel due to connection error.`);
        this.sshTunnelServer.close();
        this.sshTunnelServer = null;
      }
      this.client = null;
      // Re-throw the original error or a new error with context
      throw new Error(`[${connectionConfig.name}] Connection failed.`);
    }
  }

  /**
   * Closes the active MongoDB client connection and any active SSH tunnel.
   * @returns A promise that resolves when resources are closed.
   */
  async close(): Promise<void> {
    if (this.client) {
      try {
        await this.client.close();
        this.logger.info('MongoDB connection closed.');
      } catch (error: any) {
        this.logger.error(`Error closing MongoDB connection: ${error}`);
      } finally {
        this.client = null;
      }
    }

    if (this.sshTunnelServer) {
      this.logger.info('Closing SSH tunnel server (tunnel-ssh)...');
      try {
        await new Promise<void>((resolve, reject) => {
          this.sshTunnelServer!.close((err?: Error) => {
            if (err) {
              this.logger.error(`Error closing SSH tunnel server: ${err.message}`);
              reject(err);
            } else {
              this.logger.info('SSH tunnel server closed successfully.');
              resolve();
            }
          });
        });
      } catch (error: any) {
        this.logger.error(`Caught error during SSH tunnel server close: ${error}`);
      } finally {
        this.sshTunnelServer = null;
      }
    }
  }

  /**
   * Retrieves a list of collection names for a specified database.
   * Requires an active connection (call connect() first).
   *
   * @param dbName - The name of the database to list collections from.
   * @returns A promise resolving to an array of collection names.
   * @throws An error if not connected or if listing collections fails.
   */
  async getCollections(dbName: string): Promise<string[]> {
    if (!this.client) {
      // Use logger for error context
      this.logger.error('getCollections called while not connected to MongoDB.');
      throw new Error('Not connected to MongoDB. Call connect() first.');
    }

    try {
      const db: Db = this.client.db(dbName);
      const collectionsCursor: ListCollectionsCursor = db.listCollections({}, { nameOnly: true });
      const collections = await collectionsCursor.toArray();
      return collections.map((col) => col.name);
    } catch (error: any) {
      this.logger.error(`Error getting collection list for database "${dbName}": ${error}`);
      throw new Error(`Error getting collection list for database "${dbName}".`);
    }
  }

  getClient(): MongoClient | null {
    return this.client;
  }

  getDb(databaseName: string): Db {
    if (!this.client) {
      this.logger.error('getDb called while not connected to MongoDB.');
      throw new Error('Not connected to MongoDB. Call connect() first.');
    }
    return this.client.db(databaseName);
  }

  /**
   * Builds a MongoDB connection URI string from a ConnectionConfig object.
   * Prioritizes the `uri` field if present, otherwise constructs from components.
   *
   * @param config - The connection configuration.
   * @returns The MongoDB connection URI string.
   * @throws An error if essential components (like host/port or URI) are missing.
   */
  private buildMongoUri(config: ConnectionConfig): string {
    if (config.uri) {
      return config.uri;
    }

    let hostsStr: string;
    if (config.hosts && config.hosts.length > 0) {
      hostsStr = config.hosts.map((h) => `${h.host}${h.port ? ':' + h.port : ''}`).join(',');
    } else if (config.host) {
      hostsStr = config.host
        .split(',')
        .map((h) => {
          const trimmedHost = h.trim();
          if (config.port && !trimmedHost.includes(':')) {
            return `${trimmedHost}:${config.port}`;
          }
          return trimmedHost;
        })
        .join(',');
    } else {
      // Log error before throwing
      this.logger.error(`[${config.name}] Connection must have either 'uri', 'hosts', or 'host' defined.`);
      throw new Error(`[${config.name}] Connection must have either 'uri', 'hosts', or 'host' defined.`);
    }

    if (!config.database) {
      this.logger.error(`[${config.name}] Connection must have 'database' defined.`);
      throw new Error(`[${config.name}] Connection must have 'database' defined.`);
    }

    const authStr =
      config.username && config.password
        ? `${encodeURIComponent(config.username)}:${encodeURIComponent(config.password)}@`
        : '';

    const queryParams: Record<string, string> = {};

    const authSource = config.authSource || config.authenticationDatabase || config.authDatabase;
    if (authSource) {
      queryParams['authSource'] = authSource;
    }

    if (config.replicaSet) {
      queryParams['replicaSet'] = config.replicaSet;
    }

    if (config.options) {
      for (const [key, value] of Object.entries(config.options)) {
        if (value !== null && value !== undefined) {
          if (key !== 'replicaSet' || !queryParams['replicaSet']) {
            queryParams[key] = String(value);
          }
        }
      }
    }

    const optionsStr = Object.entries(queryParams)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
      .join('&');

    return `mongodb://${authStr}${hostsStr}/${config.database}${optionsStr ? '?' + optionsStr : ''}`;
  }

  /**
   * Establishes a MongoDB connection through an SSH tunnel using tunnel-ssh.
   * Creates an SSH tunnel and connects MongoClient to the local tunnel endpoint.
   *
   * @param config - The connection configuration including SSH details.
   * @returns A promise resolving to the connected MongoClient instance.
   * @throws An error if SSH tunnel creation or MongoDB connection via tunnel fails.
   */
  private async connectWithTunnel(config: ConnectionConfig): Promise<MongoClient> {
    if (!config.ssh) {
      this.logger.error(`[${config.name}] SSH configuration is missing for tunnel connection.`);
      throw new Error(`[${config.name}] SSH configuration is missing for tunnel connection.`);
    }
    this.logger.info(`[${config.name}] Setting up SSH tunnel using tunnel-ssh...`);

    const sshConf: SSHConfig = config.ssh!;
    const sshAuthOptions: { privateKey?: string | Buffer; password?: string; passphrase?: string } = {}; // Type from tunnel-ssh

    if (sshConf.password) {
      this.logger.info(`[${config.name}] Using SSH password authentication for user ${sshConf.username}.`);
      sshAuthOptions.password = sshConf.password;
    } else if (sshConf.privateKey) {
      this.logger.info(`[${config.name}] Using SSH private key authentication for user ${sshConf.username}.`);
      const privateKeyPath = sshConf.privateKey.startsWith('~')
        ? path.join(os.homedir(), sshConf.privateKey.substring(1))
        : sshConf.privateKey;
      try {
        // tunnel-ssh might prefer Buffer or string
        sshAuthOptions.privateKey = fs.readFileSync(privateKeyPath);
        if (sshConf.passphrase) {
          sshAuthOptions.passphrase = sshConf.passphrase;
        }
      } catch (err: any) {
        this.logger.error(`[${config.name}] Failed to read private key at ${privateKeyPath}: ${err}`);
        throw new Error(`[${config.name}] Failed to read private key at ${privateKeyPath}.`);
      }
    } else {
      this.logger.error(
        `[${config.name}] SSH configuration must include either 'password' or 'privateKey' for user ${sshConf.username}.`,
      );
      throw new Error(
        `[${config.name}] SSH configuration must include either 'password' or 'privateKey' for user ${sshConf.username}.`,
      );
    }

    // Determine target MongoDB host/port
    let targetHost: string;
    let targetPort: number;
    let parsedUriAuth: { user?: string; password?: string; authSource?: string } = {};

    // Logic to determine targetHost, targetPort, parsedUriAuth from config.uri or config.host/port/etc.
    // (Assuming this logic is correct and remains the same)
    if (config.uri) {
      try {
        const parsedUri = parseMongoUri(config.uri);
        if (!parsedUri.hosts || parsedUri.hosts.length === 0) {
          throw new Error('Could not parse target host/port from URI.');
        }
        targetHost = parsedUri.hosts[0].host;
        targetPort = parsedUri.hosts[0].port;
        parsedUriAuth = {
          user: parsedUri.user,
          password: parsedUri.password,
          authSource: parsedUri.options.authSource,
        };
      } catch (e: any) {
        this.logger.error(
          `[${config.name}] Failed to parse target host/port from provided URI (${config.uri}): ${e.message}`,
        );
        throw new Error(`[${config.name}] Failed to parse target host/port from provided URI (${config.uri}).`);
      }
    } else if (config.hosts && config.hosts.length > 0) {
      targetHost = config.hosts[0].host;
      targetPort = config.hosts[0].port || 27017;
      parsedUriAuth = {
        user: config.username,
        password: config.password,
        authSource: config.authSource || config.authenticationDatabase || config.authDatabase,
      };
    } else if (config.host) {
      const firstHost = config.host.split(',')[0].trim();
      const hostParts = firstHost.split(':');
      targetHost = hostParts[0];
      targetPort = parseInt(hostParts[1] || String(config.port || '27017'), 10);
      parsedUriAuth = {
        user: config.username,
        password: config.password,
        authSource: config.authSource || config.authenticationDatabase || config.authDatabase,
      };
    } else {
      this.logger.error(
        `[${config.name}] Cannot determine target MongoDB host/port for SSH tunnel. Provide 'uri', 'hosts', or 'host' in the connection config.`,
      );
      throw new Error(
        `[${config.name}] Cannot determine target MongoDB host/port for SSH tunnel. Provide 'uri', 'hosts', or 'host' in the connection config.`,
      );
    }

    const tunnelOptions = {
      autoClose: true,
      reconnectOnError: false,
    };

    // Config for the SSH connection itself
    const sshConnectionConfig = {
      host: sshConf.host,
      port: sshConf.port || 22,
      username: sshConf.username,
      ...sshAuthOptions,
    };

    // Config for the destination of the tunnel
    const forwardOptions = {
      srcAddr: '127.0.0.1', // Bind locally
      srcPort: 0, // Request OS-assigned ephemeral port
      dstAddr: targetHost,
      dstPort: targetPort,
    };

    try {
      this.logger.info(
        `[${config.name}] Creating tunnel: localhost:<auto> -> ${sshConf.host}:${sshConf.port || 22} -> ${targetHost}:${targetPort}`,
      );

      const [serverInstance] = await createTunnel(tunnelOptions, {}, sshConnectionConfig, forwardOptions);
      this.sshTunnelServer = serverInstance; // Store the net.Server instance

      const address = this.sshTunnelServer.address();
      if (!address || typeof address === 'string' || !address.port) {
        // Close the server if we can't get the port
        serverInstance.close();
        this.sshTunnelServer = null;
        throw new Error('Could not determine local port for tunnel');
      }
      const localPort = address.port;
      this.logger.info(
        `[${config.name}] SSH tunnel established! Forwarding localhost:${localPort} -> ${targetHost}:${targetPort}`,
      );

      // Build local URI using determined port
      const originalOptionsFiltered = Object.fromEntries(
        Object.entries(config.options || {}).filter(([key]) => key !== 'replicaSet'),
      );

      const localUriConfig: ConnectionConfig = {
        name: `${config.name}-tunnel`, // Differentiate name
        database: config.database,
        username: parsedUriAuth.user ?? config.username,
        password: parsedUriAuth.password ?? config.password,
        authSource:
          parsedUriAuth.authSource ?? config.authSource ?? config.authenticationDatabase ?? config.authDatabase,
        host: 'localhost',
        port: localPort,
        uri: undefined,
        hosts: undefined,
        replicaSet: undefined,
        ssh: undefined,
        options: {
          ...originalOptionsFiltered,
          directConnection: 'true', // Important for connecting to a specific tunneled node
        },
      };

      const localUri = this.buildMongoUri(localUriConfig);

      this.logger.info(
        `[${config.name}] Connecting to MongoDB via tunnel: ${localUri.replace(/:([^:@\/]+)@/, ':<password>@')}`,
      );

      // Connect MongoClient to the local tunnel endpoint
      const client = await MongoClient.connect(localUri);
      this.logger.info(`[${config.name}] MongoClient connected successfully via tunnel.`);
      return client;
    } catch (error: any) {
      this.logger.error(`[${config.name}] SSH tunnel setup or MongoDB connection failed: ${error}`);
      // Ensure tunnel server is closed on error
      if (this.sshTunnelServer) {
        try {
          await new Promise<void>((resolve, reject) => {
            this.sshTunnelServer!.close((err?: Error) => {
              err ? reject(err) : resolve();
            });
          });
        } catch (closeErr: any) {
          this.logger.error(
            `[${config.name}] Error closing tunnel server after connection failure: ${closeErr.message}`,
          );
        } finally {
          this.sshTunnelServer = null;
        }
      }
      throw new Error(`[${config.name}] SSH tunnel or MongoDB connection failed.`);
    }
  }
}
