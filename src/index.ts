import 'source-map-support/register';
import inquirer from 'inquirer';
import { loadConfig, savePresets } from './utils';
import { MongoDBService } from './services/mongodb.service';
import { BackupService } from './services/backup.service';
import { RestoreService } from './services/restore.service';
import ora from 'ora';
import * as fs from 'fs';
import * as path from 'path';

import { PromptService } from './utils/prompts';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { BackupPreset, RestorePreset } from './types';


// Parsing command line arguments with yargs
const argv = yargs(hideBin(process.argv))
  .option('backup', {
    describe: 'Create backup',
    type: 'boolean',
  })
  .option('restore', {
    describe: 'Restore from backup',
    type: 'boolean',
  })
  .option('nonInteractive', {
    describe: 'Run in non-interactive mode',
    type: 'boolean',
  })
  .option('config', {
    describe: 'Path to configuration file',
    type: 'string',
  })
  .option('file', {
    describe: 'Path to backup file (for restoration)',
    type: 'string',
  })
  .option('source', {
    describe: 'Source name (for backup)',
    type: 'string',
  })
  .option('target', {
    describe: 'Target name (for restoration)',
    type: 'string',
  })
  .help()
  .argv;

async function main() {
  try {
    const config = loadConfig();
    // Используем yargs вместо parseCommandLineArgs
    const mode = argv.backup ? 'backup' : argv.restore ? 'restore' : null;
    
    // Неинтерактивный режим
    if (argv.nonInteractive && mode) {
      console.log(`Running in non-interactive mode: ${mode}`);
      
      if (mode === 'backup' && argv.source) {
        await runBackup(argv.source as string, 'all', []);
        return;
      }
      
      if (mode === 'restore' && argv.file && argv.target) {
        await runRestore(argv.file as string, argv.target as string, []);
        return;
      }
      
      console.log('Insufficient parameters for non-interactive mode');
      return;
    }
    
    // Интерактивный режим
    const { action } = await inquirer.prompt({
      type: 'list',
      name: 'action',
      message: 'Select action',
      choices: [
        { name: 'Create backup', value: 'backup' },
        { name: 'Restore from backup', value: 'restore' },
        { name: 'Create backup preset', value: 'preset_backup' },
        { name: 'Create restore preset', value: 'preset_restore' },
        { name: 'Manage presets', value: 'manage_presets' }
      ]
    });
    
    if (action === 'backup') {
      await backupDatabase();
    } else if (action === 'restore') {
      await restoreDatabase();
    } else if (action === 'preset_backup') {
      await createBackupPreset();
    } else if (action === 'preset_restore') {
      await createRestorePreset();
    } else if (action === 'manage_presets') {
      await managePresets();
    }
  } catch (error) {
    console.error('An error occurred:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

// Function to run backup in non-interactive mode
async function runBackup(sourceName: string, mode: 'all' | 'include' | 'exclude', collectionsList: string[] = []): Promise<string> {
  const config = loadConfig();
  
  // Find connection by name
  const sourceConfig = config.connections.find(conn => conn.name === sourceName);
  if (!sourceConfig) {
    throw new Error(`Connection "${sourceName}" not found in configuration`);
  }
  
  // Connect to MongoDB
  const mongoService = new MongoDBService(config);
  await mongoService.connect(sourceConfig);
  console.log(`Connection successfully established to ${sourceName}`);
  
  // Get collection list
  const allCollections = await mongoService.getCollections(sourceConfig.database);
  await mongoService.close();
  
  // Define collections for backup
  let includedCollections: string[] = [];
  let excludedCollections: string[] = [];
  
  if (mode === 'all') {
    includedCollections = allCollections;
  } else if (mode === 'include') {
    includedCollections = collectionsList;
  } else if (mode === 'exclude') {
    excludedCollections = collectionsList;
    includedCollections = allCollections.filter((col: string) => !excludedCollections.includes(col));
  }
  
  // Create backup
  const backupService = new BackupService(config);
  const backupPath = await backupService.createBackup(sourceConfig, includedCollections, excludedCollections);
  
  console.log(`Backup successfully created: ${backupPath}`);
  return backupPath;
}

// Function for restoration in non-interactive mode
async function runRestore(backupFile: string, targetName: string, collections: string[] = []) {
  const config = loadConfig();
  
  
  if (!fs.existsSync(backupFile)) {
    throw new Error(`Backup file not found: ${backupFile}`);
  }
  
  const backupService = new BackupService(config);
  const backupMetadata = backupService.loadBackupMetadata(backupFile);
  
  // Find target connection
  const targetConfig = config.connections.find(conn => conn.name === targetName);
  if (!targetConfig) {
    throw new Error(`Connection "${targetName}" not found in configuration`);
  }
  
  // If collections are not specified, use all from backup
  const collectionsToRestore = collections.length > 0 ? collections : backupMetadata.collections;
  
  // Restoration
  const restoreService = new RestoreService(config);
  await restoreService.restoreBackup(backupMetadata, targetConfig, collectionsToRestore);
  
  console.log(`Backup successfully restored to database ${targetName}`);
}

async function backupDatabase() {
  const config = loadConfig();
  // Используем PromptService для интерактивного выбора
  const promptService = new PromptService(config);
  const { source, selectedCollections, excludedCollections } = await promptService.promptForBackup();
  
  // Подключение к MongoDB и получение списка коллекций
  const spinner = ora('Connecting to database...').start();
  const mongoService = new MongoDBService(config);
  
  try {
    await mongoService.connect(source);
    spinner.succeed('Connection successfully established');
    
    spinner.start('Getting collection list...');
    const collections = await mongoService.getCollections(source.database);
    spinner.succeed(`Got ${collections.length} collections`);
    
    await mongoService.close();
    
    // Create backup
    const backupService = new BackupService(config);
    spinner.start('Creating backup...');
    const backupPath = await backupService.createBackup(source, selectedCollections, excludedCollections);
    spinner.succeed(`Backup successfully created: ${backupPath}`);
    
    // Suggest to restore backup to another database
    const { restore } = await inquirer.prompt({
      type: 'confirm',
      name: 'restore',
      message: 'Do you want to restore backup to another database?',
      default: false
    });
    
    if (restore) {
      const backupMetadata = backupService.loadBackupMetadata(backupPath);
      
      const { target } = await promptService.promptForRestoreTarget(backupMetadata, source);
      const restoreService = new RestoreService(config);
      
      await restoreService.restoreBackup(backupMetadata, target);
    } else{
    console.log('Work completed. Have a good day!');
    process.exit(0);
    }
    
  } catch (error) {
    spinner.fail(`Error: ${error instanceof Error ? error.message : String(error)}`);
    await mongoService.close();
  }
}

async function restoreDatabase() {
  const config = loadConfig();
  // Use PromptService for the whole process of selection
  const promptService = new PromptService(config);
  const { backupFile, target } = await promptService.promptForRestore();
  
  // Load metadata from file
  const backupService = new BackupService(config);
  const backupMetadata = backupService.loadBackupMetadata(backupFile);
  
  // Restore backup
  const restoreService = new RestoreService(config);
  await restoreService.restoreBackup(backupMetadata, target);
}

async function createBackupPreset() {
  const config = loadConfig();
  const promptService = new PromptService(config);
  
  try {
    const preset = await promptService.promptForBackupPreset();
    
    // Initialize array of presets if it doesn't exist
    if (!config.backupPresets) {
      config.backupPresets = [];
    }
    
    // Add new preset
    config.backupPresets.push(preset);
    
    // Save configuration
    savePresets(config);
    
    console.log(`Backup preset "${preset.name}" successfully created!`);
    
    // Suggest to use preset immediately
    const { useNow } = await inquirer.prompt({
      type: 'confirm',
      name: 'useNow',
      message: 'Do you want to use this preset immediately?',
      default: true
    });
    
    if (useNow) {
      await useBackupPreset(preset);
    }
  } catch (error) {
    console.error(`Error creating preset: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function createRestorePreset() {
  const config = loadConfig();
  const promptService = new PromptService(config);
  
  try {
    const preset = await promptService.promptForRestorePreset();
    
    // Initialize array of presets if it doesn't exist
    if (!config.restorePresets) {
      config.restorePresets = [];
    }
    
    // Add new preset
    config.restorePresets.push(preset);
    
    // Save configuration
    savePresets(config);
    
    console.log(`Restore preset "${preset.name}" successfully created!`);
    
    // Suggest to use preset immediately
    const { useNow } = await inquirer.prompt({
      type: 'confirm',
      name: 'useNow',
      message: 'Do you want to use this preset immediately?',
      default: true
    });
    
    if (useNow) {
      await useRestorePreset(preset);
    }
  } catch (error) {
    console.error(`Error creating preset: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function managePresets() {
  const config = loadConfig();
  
  // Add explicit output for debugging
  console.log(`DEBUG: Config contains ${config.backupPresets?.length || 0} backup presets and ${config.restorePresets?.length || 0} restore presets`);
  if (config.backupPresets) {
    console.log(`Backup presets: ${JSON.stringify(config.backupPresets.map(p => p.name))}`);
  }
  if (config.restorePresets) {
    console.log(`Restore presets: ${JSON.stringify(config.restorePresets.map(p => p.name))}`);
  }
  
  // Check for presets
  if ((!config.backupPresets || config.backupPresets.length === 0) && 
      (!config.restorePresets || config.restorePresets.length === 0)) {
    console.log('No saved presets found. Please create a preset first.');
    return;
  }
  
  const promptService = new PromptService(config);
  
  try {
    const result = await promptService.managePresets();
    
    if (result) {
      // Using selected preset
      if (result.type === 'backup') {
        await useBackupPreset(result.preset as BackupPreset);
      } else {
        await useRestorePreset(result.preset as RestorePreset);
      }
    }
  } catch (error) {
    console.error(`Error managing presets: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function useBackupPreset(preset: BackupPreset) {
  const config = loadConfig();
  const source = config.connections.find(conn => conn.name === preset.sourceName);
  
  if (!source) {
    throw new Error(`Source "${preset.sourceName}" not found in configuration`);
  }
  
  // Create arrays of selected/excluded collections based on preset
  let selectedCollections: string[] = [];
  let excludedCollections: string[] = [];
  
  if (preset.selectionMode === 'all') {
    // All collections
    const mongoService = new MongoDBService(config);
    await mongoService.connect(source);
    selectedCollections = await mongoService.getCollections(source.database);
    await mongoService.close();
  } else if (preset.selectionMode === 'include') {
    // Only specified collections
    selectedCollections = preset.collections || [];
  } else {
    // Exclude specified collections
    excludedCollections = preset.collections || [];
    
    // Get all collections to exclude specified ones
    const mongoService = new MongoDBService(config);
    await mongoService.connect(source);
    const allCollections = await mongoService.getCollections(source.database);
    await mongoService.close();
    
    selectedCollections = allCollections.filter(coll => !excludedCollections.includes(coll));
  }
  
  // Check command before execution
  const commandArgs = [
    `--host=${source.host || 'localhost'}:${source.port || 27017}`,
    `--db=${source.database}`,
    `--gzip`,
    `--archive=./backups/backup_example.gz`
  ];
  
  if (preset.selectionMode === 'exclude') {
    excludedCollections.forEach(coll => {
      commandArgs.push(`--excludeCollection=${coll}`);
    });
  } else if (preset.selectionMode === 'include') {
    selectedCollections.forEach(coll => {
      commandArgs.push(`--collection=${coll}`);
    });
  }
  
  console.log('\nExecuting mongodump command:');
  console.log(`mongodump ${commandArgs.join(' ')}\n`);
  
  const { confirm } = await inquirer.prompt({
    type: 'confirm',
    name: 'confirm',
    message: 'Confirm command execution:',
    default: true
  });
  
  if (confirm) {
    // Run backup
    const backupService = new BackupService(config);
    const spinner = ora('Creating backup...').start();
    try {
      spinner.text = 'Running mongodump...';
      const backupPath = await backupService.createBackup(source, selectedCollections, excludedCollections);
      spinner.succeed(`Backup successfully created: ${backupPath}`);
    } catch (error) {
      spinner.fail(`Error creating backup: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

async function useRestorePreset(preset: RestorePreset) {
  const config = loadConfig();
  const target = config.connections.find(conn => conn.name === preset.targetName);
  
  if (!target) {
    throw new Error(`Target "${preset.targetName}" not found in configuration`);
  }
  
  // Get list of backup files matching pattern
  const backupService = new BackupService(config);
  const backupFiles = backupService.getBackupFiles();
  
  let filteredFiles = backupFiles;
  if (preset.backupPattern) {
    const pattern = new RegExp(preset.backupPattern.replace('*', '.*'));
    filteredFiles = backupFiles.filter(file => pattern.test(file));
  }
  
  if (filteredFiles.length === 0) {
    throw new Error('No backup files found matching pattern');
  }
  
  // Select backup file
  const { backupFile } = await inquirer.prompt({
    type: 'list',
    name: 'backupFile',
    message: 'Select backup file for restoration:',
    choices: filteredFiles
  });
  
  // Load backup metadata
  const backupMetadata = backupService.loadBackupMetadata(backupFile);
  
  // Prepare command
  const commandArgs = [
    `--host=${target.host || 'localhost'}:${target.port || 27017}`,
    `--db=${target.database}`,
    `--gzip`,
    `--archive=${path.join(config.backupDir, backupFile)}`,
    `--drop`
  ];
  
  console.log('\nCommand to be executed:');
  console.log(`mongorestore ${commandArgs.join(' ')}\n`);
  
  const { confirm } = await inquirer.prompt({
    type: 'confirm',
    name: 'confirm',
    message: 'Confirm command execution:',
    default: true
  });
  
  if (confirm) {
    // Execute restoration
    const restoreService = new RestoreService(config);
    const spinner = ora('Restoring backup...').start();
    try {
      await restoreService.restoreBackup(backupMetadata, target);
      spinner.succeed(`Backup successfully restored to database ${target.database}`);
    } catch (error) {
      spinner.fail(`Error restoring backup: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

// Run application
main().catch(console.error); 