import inquirer from 'inquirer';
import { AppConfig, ConnectionConfig, BackupMetadata, BackupPreset, RestorePreset } from '../types';
import { BackupService } from '../services/backup.service';
import { MongoDBService } from '../services/mongodb.service';
import { formatDate, savePresets } from '../utils';

export class PromptService {
  private config: AppConfig;
  private backupService: BackupService;
  private mongoService: MongoDBService;

  constructor(config: AppConfig) {
    this.config = config;
    this.backupService = new BackupService(config);
    this.mongoService = new MongoDBService(config);
  }

  async promptForBackup(): Promise<{
    source: ConnectionConfig;
    selectedCollections: string[];
    excludedCollections: string[];
  }> {
    // Show available connections
    const { sourceIndex } = await inquirer.prompt({
      type: 'list',
      name: 'sourceIndex',
      message: 'Select source for backup:',
      choices: this.config.connections.map((conn, index) => ({
        name: `${conn.name} (${conn.database})`,
        value: index
      }))
    });

    const source = this.config.connections[sourceIndex];

    // Connect to MongoDB to get collection list
    console.log(`Connecting to MongoDB ${source.name}...`);
    try {
      await this.mongoService.connect(source);
      const collections = await this.mongoService.getCollections(source.database);

      if (collections.length === 0) {
        console.log('No collections found in database');
        return { source, selectedCollections: [], excludedCollections: [] };
      }

      // Ask which collections to include
      const { allCollections } = await inquirer.prompt({
        type: 'confirm',
        name: 'allCollections',
        message: 'Include all collections in backup?',
        default: true
      });

      let selectedCollections: string[] = [];
      let excludedCollections: string[] = [];

      if (!allCollections) {
        const { selected } = await inquirer.prompt({
          type: 'checkbox',
          name: 'selected',
          message: 'Select collections to include in backup:',
          choices: collections.map(coll => ({
            name: coll,
            value: coll,
            checked: true
          }))
        });
        selectedCollections = selected;
      } else {
        // Optionally ask which collections to exclude
        const { excluded } = await inquirer.prompt({
          type: 'checkbox',
          name: 'excluded',
          message: 'Select collections to exclude from backup (optional):',
          choices: collections.map(coll => ({
            name: coll,
            value: coll
          }))
        });
        excludedCollections = excluded;
      }

      return { source, selectedCollections, excludedCollections };
    } catch (error) {
      console.error(`Error getting collection list: ${error}`);
      // Allow user to enter collections manually if unable to get them
      const { manualCollections } = await inquirer.prompt({
        type: 'input',
        name: 'manualCollections',
        message: 'Enter collection names separated by comma (or leave empty for all collections):',
      });

      const selectedCollections = manualCollections ? manualCollections.split(',').map((c: string) => c.trim()) : [];
      return { source, selectedCollections, excludedCollections: [] };
    }
  }

  async promptForRestore(): Promise<{
    target: ConnectionConfig;
    backupFile: string;
  }> {
    // Select file for restoration
    const backupService = new BackupService(this.config);
    const backupFiles = backupService.getBackupFiles();
    
    if (backupFiles.length === 0) {
      throw new Error('No backup files found in directory');
    }
    
    // Filter metadata files for clearer display
    const filteredFiles = backupFiles.map(file => {
      try {
        const metadata = backupService.loadBackupMetadata(file);
        const date = new Date(metadata.date);
        const formattedDate = formatDate(date);
        return {
          name: `${file} - ${metadata.source} (${metadata.database}) - ${formattedDate}`,
          value: file
        };
      } catch (error) {
        // If metadata cannot be loaded, just display the file name
        return {
          name: file,
          value: file
        };
      }
    });

    // Select backup file
    const { backupIndex } = await inquirer.prompt({
      type: 'list',
      name: 'backupIndex',
      message: 'Select backup to restore:',
      choices: filteredFiles
    });

    const selectedBackupFile = backupFiles[backupIndex];
    const selectedBackup = backupService.loadBackupMetadata(selectedBackupFile);

    // Select target database
    const { targetIndex } = await inquirer.prompt({
      type: 'list',
      name: 'targetIndex',
      message: 'Select target database for restore:',
      choices: this.config.connections.map((conn, index) => ({
        name: `${conn.name} (${conn.database})`,
        value: index
      }))
    });

    const target = this.config.connections[targetIndex];

    // If source and target databases are different, warn user
    if (selectedBackup.database !== target.database) {
      const { confirmDifferentDB } = await inquirer.prompt({
        type: 'confirm',
        name: 'confirmDifferentDB',
        message: `Warning! Source database (${selectedBackup.database}) and target database (${target.database}) are different. Continue?`,
        default: false
      });

      if (!confirmDifferentDB) {
        throw new Error('Restore canceled by user.');
      }
    }

    return {
      target,
      backupFile: selectedBackupFile
    };
  }

  async promptForRestoreTarget(backupMetadata: BackupMetadata, excludeSource?: ConnectionConfig): Promise<{ target: ConnectionConfig }> {
    // Filter out excluded connection if specified
    const availableConnections = excludeSource 
      ? this.config.connections.filter(conn => conn.name !== excludeSource.name)
      : this.config.connections;
      
    if (availableConnections.length === 0) {
      throw new Error('No available connections for restore.');
    }

    // Select target database
    const { targetIndex } = await inquirer.prompt({
      type: 'list',
      name: 'targetIndex',
      message: 'Select target database for restore:',
      choices: availableConnections.map((conn, index) => ({
        name: `${conn.name} (${conn.database})`,
        value: index
      }))
    });

    const target = availableConnections[targetIndex];

    // If source and target databases are different, warn user
    if (backupMetadata.database !== target.database) {
      const { confirmDifferentDB } = await inquirer.prompt({
        type: 'confirm',
        name: 'confirmDifferentDB',
        message: `Warning! Source database (${backupMetadata.database}) and target database (${target.database}) are different. Continue?`,
        default: false
      });

      if (!confirmDifferentDB) {
        throw new Error('Restore canceled by user.');
      }
    }

    return { target };
  }

  async promptForBackupPreset(): Promise<BackupPreset> {
    // Get basic information
    const { name, description } = await inquirer.prompt([
      {
        type: 'input',
        name: 'name',
        message: 'Enter preset name:',
        validate: (input: string) => {
          if (!input.trim()) return 'Name cannot be empty';
          if (this.config.backupPresets?.some(p => p.name === input.trim())) {
            return 'Preset with this name already exists';
          }
          return true;
        }
      },
      {
        type: 'input',
        name: 'description',
        message: 'Enter preset description (optional):',
      }
    ]);

    // Select source
    const { sourceIndex } = await inquirer.prompt({
      type: 'list',
      name: 'sourceIndex',
      message: 'Select source for backup:',
      choices: this.config.connections.map((conn, index) => ({
        name: `${conn.name} (${conn.database})`,
        value: index
      }))
    });

    const source = this.config.connections[sourceIndex];

    // Select collection selection mode
    const { selectionMode } = await inquirer.prompt({
      type: 'list',
      name: 'selectionMode',
      message: 'Select collection selection mode:',
      choices: [
        { name: 'All collections', value: 'all' },
        { name: 'Include only specified collections', value: 'include' },
        { name: 'Exclude specified collections', value: 'exclude' }
      ]
    });

    let collections: string[] = [];
    
    if (selectionMode !== 'all') {
      try {
        // Connect to get collection list
        const mongoService = new MongoDBService(this.config);
        await mongoService.connect(source);
        const allCollections = await mongoService.getCollections(source.database);
        await mongoService.close();
        
        // Select collections
        const { selectedCollections } = await inquirer.prompt({
          type: 'checkbox',
          name: 'selectedCollections',
          message: `Select collections to ${selectionMode === 'include' ? 'include' : 'exclude'}:`,
          choices: allCollections.map(coll => ({
            name: coll,
            value: coll
          }))
        });
        
        collections = selectedCollections;
      } catch (error) {
        console.error(`Error getting collection list: ${error}`);
        // Manual collection input
        const { manualCollections } = await inquirer.prompt({
          type: 'input',
          name: 'manualCollections',
          message: `Enter collection names separated by comma (for ${selectionMode === 'include' ? 'including' : 'excluding'}):`,
        });
        
        collections = manualCollections ? manualCollections.split(',').map((c: string) => c.trim()) : [];
      }
    }

    // Preview command
    if (selectionMode !== 'all' && collections.length > 0) {
      const commandArgs = [
        `--host=${source.host || 'localhost'}:${source.port || 27017}`,
        `--db=${source.database}`,
        `--gzip`,
        `--archive=./backups/backup_example.gz`
      ];
      
      if (selectionMode === 'include') {
        collections.forEach(coll => {
          commandArgs.push(`--collection=${coll}`);
        });
      } else {
        collections.forEach(coll => {
          commandArgs.push(`--excludeCollection=${coll}`);
        });
      }
      
      console.log('\nExecuting mongodump command:');
      console.log(`mongodump ${commandArgs.join(' ')}\n`);
    }

    return {
      name: name.trim(),
      description: description.trim() || undefined,
      sourceName: source.name,
      selectionMode,
      collections: selectionMode !== 'all' ? collections : undefined,
      createdAt: new Date().toISOString()
    };
  }

  async promptForRestorePreset(): Promise<RestorePreset> {
    // Get basic information
    const { name, description } = await inquirer.prompt([
      {
        type: 'input',
        name: 'name',
        message: 'Enter restore preset name:',
        validate: (input: string) => {
          if (!input.trim()) return 'Name cannot be empty';
          if (this.config.restorePresets?.some(p => p.name === input.trim())) {
            return 'Preset with this name already exists';
          }
          return true;
        }
      },
      {
        type: 'input',
        name: 'description',
        message: 'Enter preset description (optional):',
      }
    ]);

    // Select target database
    const { targetIndex } = await inquirer.prompt({
      type: 'list',
      name: 'targetIndex',
      message: 'Select target database for restore:',
      choices: this.config.connections.map((conn, index) => ({
        name: `${conn.name} (${conn.database})`,
        value: index
      }))
    });

    const target = this.config.connections[targetIndex];

    // Backup file pattern
    const { backupPattern } = await inquirer.prompt({
      type: 'input',
      name: 'backupPattern',
      message: 'Enter backup file name pattern (optional, e.g. "prod_*"):',
    });

    // Preview restore command
    const commandArgs = [
      `--host=${target.host || 'localhost'}:${target.port || 27017}`,
      `--db=${target.database}`,
      `--gzip`,
      `--archive=./backups/example_backup.gz`,
      `--objcheck`,
      `--drop`
    ];
    
    console.log('\nExecuting mongorestore command:');
    console.log(`mongorestore ${commandArgs.join(' ')}\n`);

    return {
      name: name.trim(),
      description: description.trim() || undefined,
      targetName: target.name,
      backupPattern: backupPattern.trim() || undefined,
      createdAt: new Date().toISOString()
    };
  }

  async managePresets(): Promise<{ type: 'backup' | 'restore', preset: BackupPreset | RestorePreset } | undefined> {
    const backupPresets = this.config.backupPresets || [];
    const restorePresets = this.config.restorePresets || [];
    
    console.log(`DEBUG: Found ${backupPresets.length} backup presets and ${restorePresets.length} restore presets`);
    
    if (backupPresets.length === 0 && restorePresets.length === 0) {
      console.log('No saved presets found. Please create a preset first.');
      return undefined;
    }
    
    const choices = [
      ...backupPresets.map(preset => ({
        name: `[Backup] ${preset.name} - ${preset.description || 'No description'}`,
        value: { type: 'backup', preset }
      })),
      ...restorePresets.map(preset => ({
        name: `[Restore] ${preset.name} - ${preset.description || 'No description'}`,
        value: { type: 'restore', preset }
      }))
    ];
    
    const { selected } = await inquirer.prompt({
      type: 'list',
      name: 'selected',
      message: 'Select preset:',
      choices
    });
    
    const { action } = await inquirer.prompt({
      type: 'list',
      name: 'action',
      message: `What do you want to do with preset "${selected.preset.name}"?`,
      choices: [
        { name: 'Use', value: 'use' },
        { name: 'View details', value: 'view' },
        { name: 'Delete', value: 'delete' }
      ]
    });
    
    if (action === 'use') {
      // Use preset
      return selected;
    } else if (action === 'view') {
      // View details
      console.log('\nPreset details:');
      console.log(JSON.stringify(selected.preset, null, 2));
      return undefined;
    } else if (action === 'delete') {
      // Delete preset
      const { confirm } = await inquirer.prompt({
        type: 'confirm',
        name: 'confirm',
        message: `Are you sure you want to delete preset "${selected.preset.name}"?`,
        default: false
      });
      
      if (confirm) {
        if (selected.type === 'backup') {
          this.config.backupPresets = backupPresets.filter(p => p.name !== selected.preset.name);
        } else {
          this.config.restorePresets = restorePresets.filter(p => p.name !== selected.preset.name);
        }
        
        // Save changes to configuration
        savePresets(this.config);
        console.log(`Preset "${selected.preset.name}" successfully deleted.`);
      }
      return undefined;
    }
    return undefined;
  }
} 