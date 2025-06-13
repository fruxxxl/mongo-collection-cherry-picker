import { AppConfig } from '@ts-types/mixed';
import { Logger } from '@infrastructure/logger';

import * as fs from 'fs';
import * as path from 'path';
import { Config } from './config';

export class UpdateableConfig {
  private config: Config;

  constructor(
    config: Config,
    protected readonly logger: Logger,
  ) {
    this.config = config;
  }

  get parsed(): AppConfig {
    return this.config.parsed;
  }

  update(updatedConfig: AppConfig): void {
    try {
      const absolutePath = path.resolve(this.config.configPath);
      const configString = JSON.stringify(updatedConfig, null, 4);
      fs.writeFileSync(absolutePath, configString, 'utf8');
      this.logger.info(`Configuration presets saved successfully to: ${absolutePath}`);
    } catch (error: any) {
      this.logger.error(`Error saving presets to configuration file "${this.config.configPath}": ${error.message}`);
      throw error;
    }
  }
}
