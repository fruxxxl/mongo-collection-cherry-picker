import { GenericContainer, StartedTestContainer } from 'testcontainers';
import { MongoClient } from 'mongodb';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const TEST_DB = 'testdb';
const BACKUP_DIR = '../test-backups';
const CONFIG_PATH = path.resolve(__dirname, '../config.container.json');

const users = [
  { name: 'Ivan', email: 'ivan@example.com', age: 30 },
  { name: 'Maria', email: 'maria@example.com', age: 25 },
  { name: 'Alex', email: 'alex@example.com', age: 40 },
];

const products = [
  { name: 'Laptop', price: 1200, category: 'Electronics' },
  { name: 'Smartphone', price: 800, category: 'Electronics' },
  { name: 'Book', price: 20, category: 'Literature' },
];

const orders = [
  { user: 'ivan@example.com', product: 'Laptop', date: new Date() },
  { user: 'maria@example.com', product: 'Smartphone', date: new Date() },
];

describe('mongo-collection-cherry-picker e2e', () => {
  let container: StartedTestContainer;
  let mongoUri: string;
  let client: MongoClient;

  beforeAll(async () => {
    // setup MongoDB
    container = await new GenericContainer('mongo:4.4').withExposedPorts(27017).start();
    const port = container.getMappedPort(27017);
    mongoUri = `mongodb://localhost:${port}`;

    // Wait, until MongoDB will be available
    client = new MongoClient(mongoUri);
    let connected = false;
    for (let i = 0; i < 20; i++) {
      try {
        await client.connect();
        connected = true;
        break;
      } catch (e) {
        await new Promise((res) => setTimeout(res, 1000));
      }
    }
    if (!connected) throw new Error('MongoDB не поднялась');

    // Initiate test data
    await client.db(TEST_DB).collection('users').insertMany(users);
    await client.db(TEST_DB).collection('products').insertMany(products);
    await client.db(TEST_DB).collection('orders').insertMany(orders);

    // Make test config
    const config = {
      backupDir: BACKUP_DIR,
      filenameFormat: 'test_backup_{date}_{source}.gz',
      mongodumpPath: 'mongodump',
      mongorestorePath: 'mongorestore',
      connections: [
        {
          name: 'test_source_db',
          uri: mongoUri + '/',
          database: TEST_DB,
          host: 'localhost',
          port: port,
        },
        {
          name: 'test_restore_db',
          uri: mongoUri + '/' + TEST_DB,
          database: TEST_DB,
          host: 'localhost',
          port: port,
        },
      ],
      backupPresets: [
        {
          name: 'users_only',
          sourceName: 'test_source_db',
          selectionMode: 'include',
          collections: ['users'],
          createdAt: new Date().toISOString(),
        },
      ],
    };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  });

  afterAll(async () => {
    if (client) await client.close();
    if (container) await container.stop();
    if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
    if (fs.existsSync(BACKUP_DIR)) {
      fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
    }
  });

  it('should backup and restore testdb', async () => {
    // Run backup
    try {
      const output = execSync(`npm run backup -- --config=${CONFIG_PATH} --source="test_source_db" --scope=all`, {
        encoding: 'utf-8',
      });
      console.log('stdout:', output);
    } catch (err) {
      const error = err as { stdout?: Buffer | string; stderr?: Buffer | string };
      console.log('stdout:', error.stdout?.toString());
      console.log('stderr:', error.stderr?.toString());
    }

    // Check if the backup file is created
    const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.gz'));
    expect(files.length).toBeGreaterThan(0);
    const backupFile = files[0];

    // Clear collections
    await client.db(TEST_DB).collection('users').deleteMany({});
    await client.db(TEST_DB).collection('products').deleteMany({});
    await client.db(TEST_DB).collection('orders').deleteMany({});

    // Restore from backup
    execSync(`npm run restore -- --config=${CONFIG_PATH} --file="${backupFile}" --target="test_restore_db"`, {
      stdio: 'inherit',
    });

    // Check if data has been restored
    const usersRestored = await client.db(TEST_DB).collection('users').find().toArray();
    const productsRestored = await client.db(TEST_DB).collection('products').find().toArray();
    const ordersRestored = await client.db(TEST_DB).collection('orders').find().toArray();

    expect(usersRestored.length).toBe(users.length);
    expect(productsRestored.length).toBe(products.length);
    expect(ordersRestored.length).toBe(orders.length);
  });

  it('should backup only users collection using preset', async () => {
    execSync(`npm run backup -- --config=${CONFIG_PATH} --preset=users_only`, { stdio: 'inherit' });
    const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.includes('test_source_db') && f.endsWith('.gz'));
    expect(files.length).toBeGreaterThan(0);
    const backupFile = files[files.length - 1];
    // Clear all collections
    await client.db(TEST_DB).collection('users').deleteMany({});
    await client.db(TEST_DB).collection('products').deleteMany({});
    await client.db(TEST_DB).collection('orders').deleteMany({});
    // Restore only users
    execSync(`npm run restore -- --config=${CONFIG_PATH} --file="${backupFile}" --target="test_restore_db"`, {
      stdio: 'inherit',
    });
    const usersRestored = await client.db(TEST_DB).collection('users').find().toArray();
    const productsRestored = await client.db(TEST_DB).collection('products').find().toArray();
    const ordersRestored = await client.db(TEST_DB).collection('orders').find().toArray();
    expect(usersRestored.length).toBe(users.length);
    expect(productsRestored.length).toBe(0);
    expect(ordersRestored.length).toBe(0);
  });

  it('should fail on non-existent preset', () => {
    expect(() => {
      execSync(`npm run backup -- --config=${CONFIG_PATH} --preset=not_exist`, { encoding: 'utf-8' });
    }).toThrow(/not found/i);
  });
});
