import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { AppConfig, BackupMetadata, ConnectionConfig } from '../types';

export class BackupService {
  private config: AppConfig;

  constructor(config: AppConfig) {
    this.config = config;
  }

  async createBackup(
    source: ConnectionConfig, 
    selectedCollections: string[], 
    excludedCollections: string[]
  ): Promise<string> {
    try {
      // Create backup directory if it doesn't exist
      if (!fs.existsSync(this.config.backupDir)) {
        fs.mkdirSync(this.config.backupDir, { recursive: true });
      }
      
      const timestamp = Date.now();
      const formattedDate = new Date().toISOString().split('T')[0];
      
      // Format file name
      const filename = this.config.filenameFormat
        .replace('{{timestamp}}', timestamp.toString())
        .replace('{{source}}', source.name.replace(/\s+/g, '_').toLowerCase())
        .replace('{{date}}', formattedDate);
      
      const filePath = path.join(this.config.backupDir, filename);
      
      // Prepare arguments for mongodump
      const args: string[] = [];
      
      // URI or host/port
      if (source.uri && !source.uri.includes('mongodb+srv')) {
        // For simple URI
        const url = new URL(source.uri);
        args.push(`--host=${url.hostname}:${url.port || 27017}`);
      } else if (source.host) {
        // If host is specified directly
        args.push(`--host=${source.host}${source.port ? `:${source.port}` : ''}`);
      }
      
      // Database
      args.push(`--db=${source.database}`);
      
      // Authentication
      if (source.username) {
        args.push(`--username=${source.username}`);
        console.log('username', source.username);
      }
      
      if (source.password) {
        args.push(`--password=${source.password}`);
      }
      
      if (source.authenticationDatabase) {
        args.push(`--authenticationDatabase=${source.authenticationDatabase}`);
      }
      
      // Include only selected collections, if not all
      if (excludedCollections.length > 0) {
        // Collection exclusion mode
        for (const collection of excludedCollections) {
          args.push(`--excludeCollection=${collection}`);
        }
      } else if (selectedCollections.length > 0) {
        // Mode to include only specified collections
        for (const collection of selectedCollections) {
          args.push(`--collection=${collection}`);
        }
      }
      
      // Output formatting
      args.push('--gzip');
      args.push(`--archive=${filePath}`);
      
      // Display command before execution
      console.log('\nExecuting mongodump command:');
      const commandString = `${this.config.mongodumpPath || 'mongodump'} ${args.join(' ')}`;
      console.log(`${commandString}\n`);
      
      // If SSH is used
      if (source.ssh) {
        // For SSH tunnel we need to create mongodump through SSH
        const sshArgs = [
          `-i`, source.ssh.privateKey,
          `-p`, source.ssh.port.toString(),
          `${source.ssh.username}@${source.ssh.host}`,
          `mongodump ${args.join(' ')}`
        ];
        
        // Create stream for writing to file
        const outputFile = fs.createWriteStream(filePath);
        
        // Execute SSH command
        const sshProcess = spawn('ssh', sshArgs);
        
        sshProcess.stdout.pipe(outputFile);
        
        // Error handling
        let errorOutput = '';
        sshProcess.stderr.on('data', (data) => {
          errorOutput += data.toString();
        });
        
        // Wait for process completion
        const exitCode = await new Promise<number>((resolve) => {
          sshProcess.on('close', resolve);
        });
        
        if (exitCode !== 0) {
          throw new Error(`SSH mongodump finished with an error: ${errorOutput}`);
        }
      } else {
        // Run mongodump directly
        const mongodumpProcess = spawn(this.config.mongodumpPath || 'mongodump', args);
        
        // Add stdout handling for progress tracking
        mongodumpProcess.stdout.on('data', (data) => {
          const output = data.toString();
          if (output.trim()) {
            console.log(`[mongodump stdout]: ${output.trim()}`);
          }
        });
        
        // Error handling
        let errorOutput = '';
        mongodumpProcess.stderr.on('data', (data) => {
          errorOutput += data.toString();
        });
        
        // Wait for process completion
        const exitCode = await new Promise<number>((resolve) => {
          mongodumpProcess.on('close', resolve);
        });
        
        if (exitCode !== 0) {
          throw new Error(`mongodump finished with an error: ${errorOutput}`);
        }
      }
      
      // Create backup metadata
      const backupMetadata: BackupMetadata = {
        source: source.name,
        database: source.database,
        collections: selectedCollections,
        timestamp,
        date: new Date().toISOString(),
        archivePath: filename
      };
      
      // Save metadata to a file alongside the archive
      const metadataPath = `${filePath}.json`;
      fs.writeFileSync(metadataPath, JSON.stringify(backupMetadata, null, 2));
      
      return filePath;
    } catch (error) {
      throw error;
    }
  }

  getBackupFiles(): string[] {
    if (!fs.existsSync(this.config.backupDir)) {
      return [];
    }
    
    return fs
      .readdirSync(this.config.backupDir)
      .filter(file => file.endsWith('.gz'))
      .sort()
      .reverse();
  }

  loadBackupMetadata(archivePath: string): BackupMetadata {
    // Determine full path to metadata file
    // If path starts with backupDir, consider it full
    const fullPath = archivePath.startsWith(this.config.backupDir) 
      ? archivePath
      : path.join(this.config.backupDir, archivePath);
    
    const metadataPath = `${fullPath}.json`;
    
    if (!fs.existsSync(metadataPath)) {
      throw new Error(`Backup metadata file not found: ${metadataPath}`);
    }
    
    const metadataJson = fs.readFileSync(metadataPath, 'utf8');
    return JSON.parse(metadataJson);
  }

  /**
   * Finds the full path to the archive file, trying different path combinations
   * @param archivePath Original path to the archive
   * @returns Full path to the file or null if the file is not found
   */
  findArchiveFile(archivePath: string): string | null {
    // Array of possible paths to check
    const pathsToCheck = [
      archivePath,
      path.join(this.config.backupDir, archivePath),
      path.join(process.cwd(), archivePath),
      path.join(process.cwd(), this.config.backupDir, archivePath),
      // Remove backupDir from path if it already exists
      archivePath.replace(`${this.config.backupDir}/`, '')
    ];
    
    // If path starts with ./ or ../, add also the absolute path
    if (archivePath.startsWith('./') || archivePath.startsWith('../')) {
      pathsToCheck.push(path.resolve(archivePath));
    }
    
    console.log('Searching for archive file. Checking paths:');
    for (const p of pathsToCheck) {
      console.log(`- ${p} (${fs.existsSync(p) ? 'exists' : 'does not exist'})`);
      if (fs.existsSync(p)) {
        return p;
      }
    }
    
    // Try searching by mask if previous attempts failed
    const fileBaseName = path.basename(archivePath);
    console.log(`Searching by mask: *${fileBaseName}`);
    
    try {
      // Check if directory exists before reading
      if (fs.existsSync(this.config.backupDir)) {
        const files = fs.readdirSync(this.config.backupDir);
        console.log(`Files in directory ${this.config.backupDir}:`, files);
        
        // Search for file with the same name
        const matchingFile = files.find(f => f === fileBaseName);
        if (matchingFile) {
          const fullPath = path.join(this.config.backupDir, matchingFile);
          console.log(`Found matching file: ${fullPath}`);
          return fullPath;
        }
      }
    } catch (error) {
      console.error(`Error trying to find file by mask: ${error}`);
    }
    
    return null;
  }

  async restoreBackup(
    target: ConnectionConfig,
    archivePath: string
  ): Promise<boolean> {
    try {
      console.log(`Full path to backup directory: ${path.resolve(this.config.backupDir)}`);
      
      // Use new method to find archive file
      const fullPath = this.findArchiveFile(archivePath);
      if (!fullPath) {
        throw new Error(`Archive file not found: ${archivePath}`);
      }
      console.log(`Using full path: ${fullPath}`);
      
      // Read file into memory
      const archiveData = fs.readFileSync(fullPath);
      console.log(`Archive size: ${archiveData.length} bytes`);
      
      // Prepare arguments for mongorestore
      const args: string[] = [];
      
      // URI or host/port
      if (target.uri && !target.uri.includes('mongodb+srv')) {
        // For simple URI
        const url = new URL(target.uri);
        args.push(`--host=${url.hostname}:${url.port || 27017}`);
      } else if (target.host) {
        // If host is specified directly
        args.push(`--host=${target.host}${target.port ? `:${target.port}` : ''}`);
      }
      
      // Database
      args.push(`--db=${target.database}`);
      
      // Authentication
      if (target.username) {
        args.push(`--username=${target.username}`);
      }
      
      if (target.password) {
        args.push(`--password=${target.password}`);
      }
      
      if (target.authenticationDatabase) {
        args.push(`--authenticationDatabase=${target.authenticationDatabase}`);
      }
      
      // Additional arguments for mongorestore
      args.push('--gzip');
      args.push(`--archive=${fullPath}`);
      
      // Add additional options for more stable restoration
      args.push('--objcheck');
      args.push('--drop'); // Drop collections before insertion
      
      // Output command for debugging
      const commandString = `${this.config.mongorestorePath || 'mongorestore'} ${args.join(' ')}`;
      console.log(`EXECUTING COMMAND: ${commandString}`);
      
      // Функция для проверки восстановления
      const checkRestoredCollections = async (dbName: string, host: string, port: string) => {
        const checkProcess = spawn('mongo', [
          `--host=${host}`,
          `--port=${port}`,
          `--quiet`,
          dbName,
          '--eval', "db.getCollectionNames()"
        ]);
        
        let checkOutput = '';
        checkProcess.stdout.on('data', (data) => {
          checkOutput += data.toString();
        });
        
        let checkErrorOutput = '';
        checkProcess.stderr.on('data', (data) => {
          checkErrorOutput += data.toString();
        });
        
        const checkExitCode = await new Promise<number>((resolve) => {
          checkProcess.on('close', resolve);
        });
        
        // Check if the command was successfully executed
        if (checkExitCode !== 0) {
          console.log(`Error checking restored collections: ${checkErrorOutput}`);
          return null;
        }
        
        console.log(`Restored collections: ${checkOutput}`);
        
        // Analyze output to check if expected collections exist
        try {
          const collections = JSON.parse(checkOutput.trim());
          console.log(`Found ${collections.length} collections in database ${dbName}`);
          
          if (collections.length === 0) {
            console.log('Attention: no collections found after restoration!');
          }
        } catch (e) {
          console.log(`Error parsing collection list: ${e}`);
        }
        
        return checkOutput;
      };
      
      // Run mongorestore with direct path to archive
      const mongorestoreProcess = spawn(this.config.mongorestorePath || 'mongorestore', args);
      
      // Handle output
      let outputData = '';
      mongorestoreProcess.stdout.on('data', (data) => {
        outputData += data.toString();
      });
      
      // Handle errors
      let errorOutput = '';
      mongorestoreProcess.stderr.on('data', (data) => {
        errorOutput += data.toString();
      });
      
      // Wait for process completion
      const exitCode = await new Promise<number>((resolve) => {
        mongorestoreProcess.on('close', resolve);
      });
      
      if (exitCode !== 0) {
        throw new Error(`mongorestore finished with an error: ${errorOutput}`);
      }
      
      // Проверка восстановленных коллекций после завершения
      const host = target.host || '127.0.0.1';
      const port = (target.port || 27017).toString();
      console.log(`Checking restoration results in ${target.database}...`);
      await checkRestoredCollections(target.database, host, port);
      
      return true;
    } catch (error) {
      throw error;
    }
  }

  getBackupMetadata(backupFile: string): BackupMetadata {
    return this.loadBackupMetadata(backupFile);
  }
} 