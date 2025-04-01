import { exec, ExecOptions } from 'child_process';

/**
 * Promisified version of child_process.exec
 *
 * @param command Command to execute
 * @param options Optional exec options
 * @returns Promise with stdout and stderr
 */
export function execPromise(command: string, options: ExecOptions = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    exec(command, options, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}
