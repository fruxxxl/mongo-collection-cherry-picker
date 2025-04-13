import { BackupController } from '../controllers/backup-controller';
import { PresetController } from '../controllers/preset-controller';
import { RestoreController } from '../controllers/restore-controller';
import { BackupService } from '../services/backup.service';
import { Config } from '../utils/config';
import { MongoDBService } from '../services/mongodb.service';
import { PromptService } from '../services/prompt-service';
import { RestoreService } from '../services/restore.service';
import { AppConfig } from '../types';

import { Logger } from '../utils/logger';

export class InteractiveModule {
  private appConfigParsed: AppConfig;
  private updatedConfig: (updatedConfig: AppConfig) => void;

  private promptService: PromptService;
  private backupController: BackupController;
  private restoreController: RestoreController;
  private presetController: PresetController;
  private logger: Logger = new Logger({ prefix: InteractiveModule.name });

  constructor(configPath: string) {
    const config = new Config(configPath, new Logger({ prefix: Config.name }));
    this.appConfigParsed = config.parsed;
    this.updatedConfig = config.update;
    const backupService = new BackupService(this.appConfigParsed, new Logger({ prefix: BackupService.name }));
    const mongoService = new MongoDBService(new Logger({ prefix: MongoDBService.name }));
    const restoreService = new RestoreService(this.appConfigParsed, new Logger({ prefix: RestoreService.name }));

    this.promptService = new PromptService(
      this.appConfigParsed,
      this.updatedConfig,
      backupService,
      mongoService,
      new Logger({ prefix: PromptService.name }),
    );

    this.backupController = new BackupController(
      this.appConfigParsed,
      this.promptService,
      mongoService,
      backupService,
      new Logger({ prefix: BackupController.name }),
    );

    this.restoreController = new RestoreController(
      this.appConfigParsed,
      backupService,
      this.promptService,
      restoreService,
      new Logger({ prefix: RestoreController.name }),
    );

    this.presetController = new PresetController(
      this.appConfigParsed,
      this.updatedConfig,
      this.backupController,
      this.promptService,
      new Logger({ prefix: PresetController.name }),
    );
  }

  async run(): Promise<void> {
    let exit = false;
    while (!exit) {
      try {
        const action = await this.promptService.askForStartAction();

        switch (action) {
          case 'backup':
            await this.backupController.backupDatabase();
            break;
          case 'restore':
            await this.restoreFromBackup();
            break;
          case 'preset_create':
            await this.presetController.createBackupPreset();
            break;
          case 'preset_manage':
            const selectedPresetAction = await this.promptService.managePresets();
            if (selectedPresetAction?.type === 'backup') {
              await this.backupController.useBackupPreset(selectedPresetAction.preset);
            }
            break;
          case 'exit':
            exit = true;
            break;
          default:
            this.logger.error('Invalid action selected.');
        }

        if (!exit) {
          const continueAction = await this.promptService.askForContinueAction();
          if (!continueAction) {
            exit = true;
          }
        }
      } catch (error: any) {
        this.logger.error(`\n✖ Interactive mode error: ${error.message}`);
        exit = true; // Exit on error
      }
    }
    this.logger.info('Exiting application.');
  }

  private async restoreFromBackup(): Promise<void> {
    try {
      // Use prompt service to get user input for restore
      const { backupFile, target, options } = await this.promptService.promptForRestore();
      // Run the restore using the collected information
      await this.restoreController.runRestore(backupFile, target.name, options);
    } catch (error: any) {
      this.logger.error(`\n✖ Restore failed: ${error.message}`);
      // Error is logged, no need to re-throw unless specific handling is needed here
    }
  }
}
