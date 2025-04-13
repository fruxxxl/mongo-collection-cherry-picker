import { AppConfig } from '../types';
import { Logger } from './logger';
import { AppConfigSchema } from '../zod-schemas/config.schema';
import * as fs from 'fs';
import * as path from 'path';

export class Config {
  private _parsed: AppConfig;
  private _configPath: string;

  constructor(
    configPath: string,
    private logger: Logger,
  ) {
    this._parsed = this.load(configPath);
    this._configPath = configPath;
  }

  get parsed(): AppConfig {
    return this._parsed;
  }

  update(updatedConfig: AppConfig): void {
    try {
      const absolutePath = path.resolve(this._configPath);
      const configString = JSON.stringify(updatedConfig, null, 4);
      fs.writeFileSync(absolutePath, configString, 'utf8');
      this.logger.info(`Configuration presets saved successfully to: ${absolutePath}`);
    } catch (error: any) {
      this.logger.error(`Error saving presets to configuration file "${this._configPath}": ${error.message}`);
      throw error;
    }
  }

  load(configPath: string): AppConfig {
    try {
      const absolutePath = path.resolve(configPath);
      this.logger.info(`Loading configuration from: ${absolutePath}`);
      if (!fs.existsSync(absolutePath)) {
        throw new Error(`Configuration file not found at ${absolutePath}`);
      }
      const configJson = fs.readFileSync(absolutePath, 'utf8');
      const configData = JSON.parse(configJson);

      const validationResult = AppConfigSchema.safeParse(configData);
      if (!validationResult.success) {
        this.logger.error('Configuration validation failed:');
        validationResult.error.errors.forEach((err) => {
          this.logger.error(`  Path: ${err.path.join('.') || '.'}, Message: ${err.message}`);
        });
        throw new Error('Invalid configuration file structure.');
      }

      this.logger.info('Configuration loaded and validated successfully.');
      return validationResult.data;
    } catch (error: any) {
      this.logger.error(`Error loading or parsing configuration file "${configPath}": ${error.message}`);
      throw error;
    }
  }
}
