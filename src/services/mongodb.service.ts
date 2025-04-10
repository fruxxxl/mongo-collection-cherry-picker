import { MongoClient, Db, ListCollectionsCursor } from 'mongodb';

import { AppConfig, ConnectionConfig, SSHConfig } from '../types/index';
import { createTunnel } from 'tunnel-ssh';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { URLSearchParams } from 'url';
import type { Server } from 'net';

function parseMongoUri(uri: string): {
  user?: string;
  password?: string;
  hosts: { host: string; port: number }[];
  database?: string;
  options: Record<string, string>;
} {
  const mongoUriRegex = /^mongodb:\/\/(?:([^:]+)(?::([^@]+))?@)?([^/?]+)(?:\/([^?]+))?(?:\?(.+))?$/;
  let match = uri.match(mongoUriRegex);

  if (!match) {
    const uriWithSlash = uri.includes('?') && !uri.includes('/?') ? uri.replace('?', '/?') : uri;
    const fallbackMatch = uriWithSlash.match(mongoUriRegex);
    if (!fallbackMatch) {
      console.error('Failed to parse URI with regex:', uri);
      throw new Error('Invalid MongoDB URI format');
    }
    console.warn('Parsed URI using fallback with added slash.');
    match = fallbackMatch;
  }

  const [, user, password, hostString, database, optionString] = match!;

  const hosts = hostString.split(',').map((hostPort) => {
    const parts = hostPort.split(':');
    const host = parts[0];
    const port = parseInt(parts[1] || '27017', 10);
    if (isNaN(port)) {
      throw new Error(`Invalid port number in host string: ${hostPort}`);
    }
    return { host, port };
  });

  const options: Record<string, string> = {};
  if (optionString) {
    const params = new URLSearchParams(optionString);
    params.forEach((value, key) => {
      options[key] = value;
    });
  }

  return {
    user: user ? decodeURIComponent(user) : undefined,
    password: password ? decodeURIComponent(password) : undefined,
    hosts,
    database: database ? database.split('/')[0] : undefined,
    options,
  };
}

/**
 * Provides services for connecting to MongoDB instances,
 * including handling connections via SSH tunnels.
 */
export class MongoDBService {
  private config: AppConfig;
  private client: MongoClient | null = null;
  private sshTunnelServer: Server | null = null;

  /**
   * Creates an instance of MongoDBService.
   * @param config - The application configuration.
   */
  constructor(config: AppConfig) {
    this.config = config;
  }

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
      console.warn(`[${connectionConfig.name}] Already connected. Closing existing connection before reconnecting.`);
      await this.close();
    }

    try {
      if (connectionConfig.ssh) {
        this.client = await this.connectWithTunnel(connectionConfig);
        console.log(`[${connectionConfig.name}] Connection successfully established via SSH tunnel.`);
      } else {
        const uri = this.buildMongoUri(connectionConfig);
        console.log(
          `[${connectionConfig.name}] Connecting directly to MongoDB with URI: ${uri.replace(/:([^:@\/]+)@/, ':<password>@')}`,
        );
        this.client = await MongoClient.connect(uri);
        console.log(`[${connectionConfig.name}] Direct connection successfully established.`);
      }
    } catch (error: any) {
      console.error(`[${connectionConfig.name}] Connection failed in connect method:`, error);
      if (this.sshTunnelServer) {
        console.error(`[${connectionConfig.name}] Closing SSH tunnel due to connection error.`);
        this.sshTunnelServer.close();
        this.sshTunnelServer = null;
      }
      this.client = null;
      throw new Error(`[${connectionConfig.name}] Error connecting: ${error.message || error}`);
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
        console.log('MongoDB connection closed.');
      } catch (error: any) {
        console.error(`Error closing MongoDB connection: ${error.message}`);
      } finally {
        this.client = null;
      }
    }

    if (this.sshTunnelServer) {
      console.log('Closing SSH tunnel...');
      try {
        if (typeof this.sshTunnelServer.close === 'function') {
          this.sshTunnelServer.close();
          console.log('SSH tunnel closed.');
        } else {
          console.warn('SSH tunnel server does not have a close method.');
        }
      } catch (error: any) {
        console.error(`Error closing SSH tunnel: ${error.message}`);
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
      throw new Error('Not connected to MongoDB. Call connect() first.');
    }

    try {
      const db: Db = this.client.db(dbName);
      const collectionsCursor: ListCollectionsCursor = db.listCollections({}, { nameOnly: true });
      const collections = await collectionsCursor.toArray();
      return collections.map((col) => col.name);
    } catch (error: any) {
      console.error(`Error getting collection list for database "${dbName}":`, error);
      throw new Error(`Error getting collection list for database "${dbName}": ${error.message || error}`);
    }
  }

  getClient(): MongoClient | null {
    return this.client;
  }

  getDb(databaseName: string): Db {
    if (!this.client) {
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
      throw new Error(`[${config.name}] Connection must have either 'uri', 'hosts', or 'host' defined.`);
    }

    if (!config.database) {
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
   * Establishes a MongoDB connection through an SSH tunnel.
   * Creates an SSH tunnel and connects MongoClient to the local tunnel endpoint.
   *
   * @param config - The connection configuration including SSH details.
   * @returns A promise resolving to the connected MongoClient instance.
   * @throws An error if SSH tunnel creation or MongoDB connection via tunnel fails.
   */
  private async connectWithTunnel(config: ConnectionConfig): Promise<MongoClient> {
    if (!config.ssh) {
      throw new Error(`[${config.name}] SSH configuration is missing for tunnel connection.`);
    }
    console.log(`[${config.name}] Setting up SSH tunnel...`);

    const sshConf: SSHConfig = config.ssh!;

    const privateKeyPath = sshConf.privateKey.startsWith('~')
      ? path.join(os.homedir(), sshConf.privateKey.substring(1))
      : sshConf.privateKey;

    let privateKeyContent: string;
    try {
      privateKeyContent = fs.readFileSync(privateKeyPath, 'utf-8');
    } catch (err: any) {
      throw new Error(`[${config.name}] Failed to read private key at ${privateKeyPath}: ${err.message}`);
    }

    let targetHost: string;
    let targetPort: number;
    let parsedUriAuth: { user?: string; password?: string; authSource?: string } = {};

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
        throw new Error(
          `[${config.name}] Failed to parse target host/port from provided URI (${config.uri}): ${e.message}`,
        );
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
      throw new Error(
        `[${config.name}] Cannot determine target MongoDB host/port for SSH tunnel. Provide 'uri', 'hosts', or 'host' in the connection config.`,
      );
    }

    const tunnelOptions = {
      autoClose: true,
      reconnectOnError: false,
    };

    const sshConnectionConfig = {
      host: sshConf.host,
      port: sshConf.port || 22,
      username: sshConf.username,
      privateKey: privateKeyContent,
      passphrase: sshConf.passphrase,
    };

    const serverPort = 0;

    const forwardOptions = {
      srcAddr: '127.0.0.1',
      srcPort: serverPort,
      dstAddr: targetHost,
      dstPort: targetPort,
    };

    try {
      console.log(
        `[${config.name}] Creating tunnel: localhost:<auto> -> ${sshConf.host}:${sshConf.port || 22} -> ${targetHost}:${targetPort}`,
      );
      const [serverInstance] = await createTunnel(tunnelOptions, {}, sshConnectionConfig, forwardOptions);
      this.sshTunnelServer = serverInstance;

      const address = this.sshTunnelServer.address();
      if (!address || typeof address === 'string' || !address.port) {
        throw new Error('Could not determine local port for tunnel');
      }
      const localPort = address.port;
      console.log(
        `[${config.name}] SSH tunnel established! Forwarding localhost:${localPort} -> ${targetHost}:${targetPort}`,
      );

      const originalOptionsFiltered = Object.fromEntries(
        Object.entries(config.options || {}).filter(([key]) => key !== 'replicaSet'),
      );

      const localUriConfig: ConnectionConfig = {
        name: config.name,
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
          // directConnection: 'true',
        },
      };

      const localUri = this.buildMongoUri(localUriConfig);

      console.log(
        `[${config.name}] Connecting to MongoDB via tunnel: ${localUri.replace(/:([^:@\/]+)@/, ':<password>@')}`,
      );

      const client = await MongoClient.connect(localUri);
      return client;
    } catch (error: any) {
      console.error(`[${config.name}] SSH tunnel or MongoDB connection failed:`, error);
      if (this.sshTunnelServer) {
        this.sshTunnelServer.close();
        this.sshTunnelServer = null;
      }
      throw new Error(`[${config.name}] SSH tunnel or MongoDB connection failed: ${error.message || error}`);
    }
  }
}
