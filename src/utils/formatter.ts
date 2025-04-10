import { format } from 'date-fns';

/**
 * Generates formatted date and datetime strings from a Date object.
 *
 * @param now - The Date object to format.
 * @returns An object containing the formatted date (`DD-MM-YYYY`) and datetime (`DD-MM-YYYY_HH-mm`) strings.
 */
export function getFormattedTimestamps(date: Date): { date: string; time: string; datetime: string } {
  return {
    date: format(date, 'dd-MM-yyyy'),
    time: format(date, 'HH-mm'),
    datetime: format(date, 'yyyy-MM-dd_HH-mm-ss'), // Added a combined datetime
  };
}

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
  sourceName: string,
): string {
  return formatString
    .replace('{date}', dateStr)
    .replace('{time}', timeStr)
    .replace('{datetime}', datetimeStr)
    .replace('{source}', sourceName);
}

/**
 * Generates the minimal ObjectId hex string corresponding to a given timestamp.
 * Used for creating $gte queries based on time.
 * @param date - The date object representing the start time.
 * @returns A 24-character hex string representing the ObjectId.
 */
export function objectIdFromTimestamp(date: Date): string {
  // Get seconds since epoch
  const timestampSeconds = Math.floor(date.getTime() / 1000);
  // Convert to 4-byte hex string (8 characters)
  const hexTimestamp = timestampSeconds.toString(16).padStart(8, '0');
  // Append 16 zeros for the rest of the ObjectId parts (machine, pid, counter)
  return hexTimestamp + '0000000000000000';
}
