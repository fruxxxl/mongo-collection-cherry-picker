import { BackupController } from '@modules/backup/controllers/backup-controller';
import { PresetController } from '@modules/prompt/controllers/preset-controller';
import { RestoreController } from '@modules/restore/controllers/restore-controller';
import { BackupService } from '@modules/backup/services/backup.service';
import { Config } from '@config/config';
import { MongoDBService } from '@infrastructure/mongodb.service';
import { PromptService } from '@modules/prompt/services/prompt-service';

import { AppConfig } from '@ts-types/mixed';

import { Logger } from '@infrastructure/logger';
import { UpdateableConfig } from '@config/updateable-config';
import { RestoreService } from '@modules/restore/services/restore.service';

export class InteractiveMode {
  private appConfigParsed: AppConfig;

  private promptService: PromptService;
  private backupController: BackupController;
  private restoreController: RestoreController;
  private presetController: PresetController;
  private logger: Logger = new Logger({ prefix: InteractiveMode.name });

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
      this.promptService,
      new Logger({ prefix: PresetController.name }),
    );
  }

  async run(): Promise<void> {
    const actions: Record<string, () => Promise<void>> = {
      backup: () => this.backupController.backupDatabase(),
      restore: () => this.restoreController.restoreDatabaseInteractively(),
      preset_create: async () => {
        const preset = await this.presetController.createPresetInteractively();
        if (preset && (await this.promptService.askRunPresetNow())) {
          await this.backupController.useBackupPreset(preset);
        }
      },
      preset_manage: async () => {
        const preset = await this.presetController.managePresetsFlow();
        if (preset && (await this.promptService.askRunPresetNow())) {
          await this.backupController.useBackupPreset(preset);
        }
      },
    };

    let exit = false;

    while (!exit) {
      try {
        const action = await this.promptService.askStartAction();

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
          const continueAction = await this.promptService.askContinueAction();
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
