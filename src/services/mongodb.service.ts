import { MongoClient } from 'mongodb';
import { AppConfig, ConnectionConfig } from '../types/index';

export class MongoDBService {
  private config: AppConfig;
  private client: MongoClient | null = null;

  constructor(config: AppConfig) {
    this.config = config;
  }

  async connect(connectionConfig: ConnectionConfig): Promise<MongoClient> {
    try {
      let uri: string;

      if (connectionConfig.uri) {
        // use provided uri if it exists
        uri = connectionConfig.uri;
      } else if (connectionConfig.hosts && connectionConfig.hosts.length > 0) {
        // build uri for replica set
        const hostsStr = connectionConfig.hosts
          .map((h) => `${h.host}${h.port ? ':' + h.port : ''}`)
          .join(',');

        // create auth string if credentials are provided
        const authStr =
          connectionConfig.username && connectionConfig.password
            ? `${encodeURIComponent(connectionConfig.username)}:${encodeURIComponent(connectionConfig.password)}@`
            : '';

        // create options string
        let optionsStr = '';

        // add authSource if it is specified
        if (connectionConfig.authDatabase || connectionConfig.authenticationDatabase) {
          optionsStr += `authSource=${connectionConfig.authDatabase || connectionConfig.authenticationDatabase}`;
        }

        // add replica set name if it is specified
        if (connectionConfig.replicaSet) {
          optionsStr += optionsStr ? '&' : '';
          optionsStr += `replicaSet=${connectionConfig.replicaSet}`;
        }

        // add additional options if they are specified
        if (connectionConfig.options) {
          for (const [key, value] of Object.entries(connectionConfig.options)) {
            optionsStr += optionsStr ? '&' : '';
            optionsStr += `${key}=${value}`;
          }
        }

        // build full uri
        uri = `mongodb://${authStr}${hostsStr}/${connectionConfig.database}${optionsStr ? '?' + optionsStr : ''}`;
      } else if (connectionConfig.host && connectionConfig.host.includes(',')) {
        // handle case when host contains multiple hosts separated by comma
        const hosts = connectionConfig.host.split(',').map((h) => h.trim());

        // create hosts string
        const hostsStr = hosts.join(',');

        // create auth string
        const authStr =
          connectionConfig.username && connectionConfig.password
            ? `${encodeURIComponent(connectionConfig.username)}:${encodeURIComponent(connectionConfig.password)}@`
            : '';

        // create options string
        let optionsStr = '';

        // add authSource
        if (connectionConfig.authenticationDatabase || connectionConfig.authDatabase) {
          optionsStr += `authSource=${connectionConfig.authenticationDatabase || connectionConfig.authDatabase}`;
        }

        // build full uri
        uri = `mongodb://${authStr}${hostsStr}/${connectionConfig.database}${optionsStr ? '?' + optionsStr : ''}`;
      } else {
        // standard case with one host and port
        uri = `mongodb://${connectionConfig.host}:${connectionConfig.port}/${connectionConfig.database}`;
      }

      console.log(`Connecting to MongoDB with URI: ${uri.replace(/:[^:\/]+@/, ':***@')}`); // hide password in logs

      this.client = await MongoClient.connect(uri);
      console.log(`Connection successfully established to ${connectionConfig.name}`);
      return this.client;
    } catch (error) {
      console.error(`Error connecting to ${connectionConfig.name}: ${error}`);
      throw error;
    }
  }

  async getCollections(databaseName: string): Promise<string[]> {
    if (!this.client) {
      throw new Error('First, you need to connect to MongoDB');
    }

    try {
      const db = this.client.db(databaseName);
      const collections = await db.listCollections().toArray();
      return collections.map((coll) => coll.name);
    } catch (error) {
      console.error(`Error getting collection list: ${error}`);
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
      console.log('MongoDB connection closed');
    }
  }
}
