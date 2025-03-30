import { MongoClient } from 'mongodb';
import { AppConfig, ConnectionConfig } from '../types';

export class MongoDBService {
  private config: AppConfig;
  private client: MongoClient | null = null;

  constructor(config: AppConfig) {
    this.config = config;
  }

  async connect(connectionConfig: ConnectionConfig): Promise<MongoClient> {
    try {
      const uri = connectionConfig.uri || `mongodb://${connectionConfig.host}:${connectionConfig.port}/${connectionConfig.database}`;
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
      return collections.map(coll => coll.name);
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