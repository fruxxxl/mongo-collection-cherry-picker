/**
 * Generates formatted date and datetime strings from a Date object.
 *
 * @param now - The Date object to format.
 * @returns An object containing the formatted date (`DD-MM-YYYY`) and datetime (`DD-MM-YYYY_HH-mm`) strings.
 */
export function getFormattedTimestamps(now: Date): { date: string; datetime: string } {
  const year = now.getFullYear();
  const month = (now.getMonth() + 1).toString().padStart(2, '0'); // Months are 0-indexed
  const day = now.getDate().toString().padStart(2, '0');
  const hours = now.getHours().toString().padStart(2, '0');
  const minutes = now.getMinutes().toString().padStart(2, '0');
  // Seconds are excluded as requested

  const date = `${day}-${month}-${year}`; // DD-MM-YYYY
  const datetime = `${day}-${month}-${year}_${hours}-${minutes}`; // DD-MM-YYYY_HH-mm

  return { date, datetime };
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
export function formatFilename(formatString: string, date: string, datetime: string, sourceName: string): string {
  let filename = formatString;
  // Replace datetime first if present
  filename = filename.replace('{{datetime}}', datetime);
  // Replace date (useful if datetime wasn't in the format string)
  filename = filename.replace('{{date}}', date);
  filename = filename.replace('{{source}}', sourceName);
  // Add more replacements here if needed in the future
  return filename;
}
