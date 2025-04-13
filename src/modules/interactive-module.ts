import { BackupManager } from '../controllers/backup-manager';
import { PresetManager } from '../controllers/preset-manager';
import { RestoreManager } from '../controllers/restore-manager';
import { BackupService } from '../services/backup.service';
import { MongoDBService } from '../services/mongodb.service';
import { PromptService } from '../services/prompt-service';
import { RestoreService } from '../services/restore.service';
import { AppConfig } from '../types';
import { loadConfig } from '../utils';
import { Logger } from '../utils/logger';

export class InteractiveModule {
  private config: AppConfig;

  private promptService: PromptService;
  private backupManager: BackupManager;
  private restoreManager: RestoreManager;
  private presetManager: PresetManager;
  private logger: Logger = new Logger({ prefix: 'InteractiveModule' });

  constructor(configPath: string) {
    this.config = loadConfig(configPath);

    const backupService = new BackupService(this.config, new Logger({ prefix: 'BackupService' }));
    const mongoService = new MongoDBService(this.config, new Logger({ prefix: 'MongoDBService' }));
    const restoreService = new RestoreService(this.config, new Logger({ prefix: 'RestoreService' }));

    this.promptService = new PromptService(
      this.config,
      backupService,
      mongoService,
      new Logger({ prefix: 'PromptService' }),
    );

    this.backupManager = new BackupManager(
      this.config,
      this.promptService,
      mongoService,
      backupService,
      new Logger({ prefix: 'BackupManager' }),
    );

    this.restoreManager = new RestoreManager(
      this.config,
      backupService,
      this.promptService,
      restoreService,
      new Logger({ prefix: 'RestoreManager' }),
    );

    this.presetManager = new PresetManager(
      this.config,
      this.backupManager,
      this.promptService,
      new Logger({ prefix: 'PresetManager' }),
    );
  }

  /**
   * Runs the interactive mode workflow.
   * Prompts the user for actions and handles them accordingly.
   * Exits when the user chooses to exit the application.
   */
  async run(): Promise<void> {
    let exit = false;
    while (!exit) {
      try {
        const action = await this.promptService.askForStartAction();

        switch (action) {
          case 'backup':
            await this.backupManager.backupDatabase();
            break;
          case 'restore':
            await this.restoreFromBackup();
            break;
          case 'preset_create':
            await this.presetManager.createBackupPreset();
            break;
          case 'preset_manage':
            const selectedPresetAction = await this.promptService.managePresets();
            if (selectedPresetAction?.type === 'backup') {
              await this.backupManager.useBackupPreset(selectedPresetAction.preset);
            }
            break;
          case 'exit':
            exit = true;
            break;
          default:
            console.log('Invalid action selected.');
        }

        if (!exit) {
          const continueAction = await this.promptService.askForContinueAction();
          if (!continueAction) {
            exit = true;
          }
        }
      } catch (error: any) {
        console.error(`\n✖ Interactive mode error: ${error.message}`);
        exit = true; // Exit on error
      }
    }
    this.logger.info('Exiting application.');
  }

  /**
   * Handles the interactive restore workflow using PromptService.
   * @private
   */
  private async restoreFromBackup(): Promise<void> {
    try {
      // Use prompt service to get user input for restore
      const { backupFile, target, options } = await this.promptService.promptForRestore();
      // Run the restore using the collected information
      await this.restoreManager.runRestore(backupFile, target.name, options);
    } catch (error: any) {
      console.error(`\n✖ Restore failed: ${error.message}`);
      // Error is logged, no need to re-throw unless specific handling is needed here
    }
  }
}
