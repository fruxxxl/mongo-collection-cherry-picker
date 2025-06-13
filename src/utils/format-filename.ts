/**
 * Formats a filename based on a template string, date/datetime, and source name.
 * Replaces placeholders like {{date}}, {{datetime}}, and {{source}}.
 *
 * @param formatString - The template string for the filename (e.g., "backup_{{datetime}}_{{source}}.gz").
 * @param date - The date string (e.g., "DD-MM-YYYY").
 * @param datetime - The datetime string (e.g., "DD-MM-YYYY_HH-mm").
 * @param sourceName - The name of the connection source.
 * @returns The formatted filename string.
 */

export function formatFilename(
  formatString: string,
  dateStr: string,
  timeStr: string,
  datetimeStr: string,
  sourceName: string
): string {
  return formatString
    .replace('{date}', dateStr)
    .replace('{time}', timeStr)
    .replace('{datetime}', datetimeStr)
    .replace('{source}', sourceName);
}
