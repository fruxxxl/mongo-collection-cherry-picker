/**
 * Formats a filename based on a template string, date, and source name.
 * Replaces placeholders like {{date}} and {{source}}.
 *
 * @param formatString - The template string for the filename (e.g., "backup_{{date}}_{{source}}.gz").
 * @param date - The date string (e.g., "YYYY-MM-DD").
 * @param sourceName - The name of the connection source.
 * @returns The formatted filename string.
 */
export function formatFilename(formatString: string, date: string, sourceName: string): string {
  let filename = formatString;
  filename = filename.replace('{{date}}', date);
  filename = filename.replace('{{source}}', sourceName);
  // Add more replacements here if needed in the future
  return filename;
}
