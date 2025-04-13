import ora, { Ora } from 'ora';
import chalk from 'chalk';

/**
 * Centralized logger service for handling console output and spinners.
 * Uses 'ora' for spinners and 'chalk' for colors.
 */
export class Logger {
  private spinner: Ora | null = null;
  private isDebugEnabled: boolean;
  private prefix: string;
  /**
   * Creates an instance of Logger.
   * @param options - Configuration options for the logger.
   * @param options.debug - Enable debug logging (default: false).
   */
  constructor(options: { debug?: boolean; prefix?: string } = {}) {
    this.isDebugEnabled = options.debug ?? false;
    this.prefix = options.prefix ?? '';
  }

  /**
   * Logs an informational message.
   * Stops the spinner temporarily if active.
   * @param messages - The message(s) to log.
   */
  info(...messages: any[]): void {
    const formattedMessage = messages.map((msg) => chalk.blue(`${this.prefix} ${msg}`)).join(' ');

    if (this.spinner?.isSpinning) {
      this.spinner.stopAndPersist({ text: formattedMessage, symbol: 'ℹ️' });
      this.spinner = null;
    } else {
      console.info(formattedMessage);
    }
  }

  /**
   * Logs a warning message.
   * Stops the spinner temporarily if active.
   * @param messages - The warning message(s).
   */
  warn(...messages: any[]): void {
    const formattedMessage = messages.map((msg) => chalk.yellow(`${this.prefix} ${msg}`)).join(' ');

    if (this.spinner?.isSpinning) {
      this.spinner.warn(formattedMessage);
      this.spinner = null;
    } else {
      console.warn(`⚠️ ${formattedMessage}`);
    }
  }

  /**
   * Logs an error message.
   * Fails the spinner if active.
   * @param messages - The error message(s) or Error object(s).
   */
  error(...messages: any[]): void {
    const formattedMessages = messages
      .map((msg) => {
        if (msg instanceof Error) {
          return msg.message;
        }
        return msg;
      })
      .map((msg) => chalk.red(`${this.prefix} ${msg}`))
      .join(' ');

    if (this.spinner?.isSpinning) {
      this.spinner.fail(formattedMessages);
      this.spinner = null;
    } else {
      console.error(`✖ ${formattedMessages}`);
      messages.forEach((msg) => {
        if (msg instanceof Error && msg.stack && this.isDebugEnabled) {
          console.error(chalk.red(msg.stack));
        }
      });
    }
  }

  /**
   * Logs a debug message only if debug mode is enabled.
   * Stops the spinner temporarily if active.
   * @param messages - The debug message(s).
   */
  debug(...messages: any[]): void {
    if (!this.isDebugEnabled) {
      return;
    }
    const formattedMessage = messages.map((msg) => chalk.grey(`${this.prefix} [Debug] ${msg}`)).join(' ');

    if (this.spinner?.isSpinning) {
      this.spinner.stop();
      console.debug(formattedMessage);
      this.spinner.start();
    } else {
      console.debug(formattedMessage);
    }
  }

  /**
   * Starts a new spinner.
   * If a spinner is already active, it will be stopped first.
   * @param message - The initial message for the spinner.
   */
  startSpinner(message: string): void {
    if (this.spinner?.isSpinning) {
      this.spinner.stop(); // Stop previous spinner
    }
    this.spinner = ora(message).start();
  }

  /**
   * Updates the text of the active spinner.
   * Does nothing if no spinner is active.
   * @param message - The new message for the spinner.
   */
  updateSpinner(message: string): void {
    if (this.spinner?.isSpinning) {
      this.spinner.text = message;
    }
  }

  /**
   * Stops the active spinner and removes it from the console.
   * Does nothing if no spinner is active.
   */
  stopSpinner(): void {
    if (this.spinner?.isSpinning) {
      this.spinner.stop();
      this.spinner = null;
    }
  }

  /**
   * Stops the active spinner with a success symbol (✔).
   * @param message - Optional final message.
   */
  succeedSpinner(message?: string): void {
    if (this.spinner?.isSpinning) {
      this.spinner.succeed(message); // Ora handles colors
      this.spinner = null;
    }
  }

  /**
   * Stops the active spinner with a failure symbol (✖).
   * @param message - Optional final message.
   */
  failSpinner(message?: string): void {
    if (this.spinner?.isSpinning) {
      this.spinner.fail(message); // Ora handles colors
      this.spinner = null;
    }
  }

  /**
   * Persists the current spinner text with a specified symbol and message.
   * Stops the spinner.
   * @param text - The text to persist.
   * @param symbol - The symbol to use (e.g., 'ℹ️').
   */
  persistSpinnerInfo(text: string, symbol = 'ℹ️'): void {
    if (this.spinner?.isSpinning) {
      this.spinner.stopAndPersist({ text, symbol });
      this.spinner = null;
    }
  }

  /**
   * Logs raw data, useful for debugging complex objects.
   * Stops the spinner temporarily if active.
   * @param data - The data to log.
   */
  logRaw(data: any): void {
    if (this.spinner?.isSpinning) {
      this.spinner.stop();
      console.log(data);
      this.spinner.start();
    } else {
      console.log(data);
    }
  }
}
