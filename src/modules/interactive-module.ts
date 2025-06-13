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
import { UpdateableConfig } from '../utils/updateable-config';

export class InteractiveModule {
  private appConfigParsed: AppConfig;

  private promptService: PromptService;
  private backupController: BackupController;
  private restoreController: RestoreController;
  private presetController: PresetController;
  private logger: Logger = new Logger({ prefix: InteractiveModule.name });

  constructor(configPath: string) {
    const config = new Config(configPath, new Logger({ prefix: Config.name }));
    this.appConfigParsed = config.parsed;
    const updateableConfig = new UpdateableConfig(config, new Logger({ prefix: UpdateableConfig.name }));
    const backupService = new BackupService(this.appConfigParsed, new Logger({ prefix: BackupService.name }));
    const mongoService = new MongoDBService(new Logger({ prefix: MongoDBService.name }));
    const restoreService = new RestoreService(this.appConfigParsed, new Logger({ prefix: RestoreService.name }));

    this.promptService = new PromptService(
      updateableConfig,
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
      updateableConfig,
      this.backupController,
      this.promptService,
      new Logger({ prefix: PresetController.name }),
    );
  }

  async run(): Promise<void> {
    const actions: Record<string, () => Promise<void>> = {
      backup: () => this.backupController.backupDatabase(),
      restore: () => this.restoreController.restoreDatabase(),
      preset_create: () => this.presetController.createBackupPreset(),
      preset_manage: () => this.presetController.managePresetsFlow(),
    };

    let exit = false;

    while (!exit) {
      try {
        const action = await this.promptService.askForStartAction();

        if (action === 'exit') {
          exit = true;
          continue;
        }

        const handler = actions[action];
        if (handler) {
          await handler();
        } else {
          this.logger.error('Invalid action selected.');
        }

        if (!exit) {
          const continueAction = await this.promptService.askForContinueAction();
          if (!continueAction) exit = true;
        }
      } catch (error: any) {
        this.logger.error(`✖ Interactive mode error: ${error.message}`);
        exit = true;
      }
    }
    this.logger.info('Exiting application.');
  }
}
