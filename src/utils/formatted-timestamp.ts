import { format } from 'date-fns';

/**
 * Generates formatted date and datetime strings from a Date object.
 *
 * @param now - The Date object to format.
 * @returns An object containing the formatted date (`DD-MM-YYYY`) and datetime (`DD-MM-YYYY_HH-mm`) strings.
 */

export function formattedTimestamp(date: Date): { date: string; time: string; datetime: string } {
  return {
    date: format(date, 'dd-MM-yyyy'),
    time: format(date, 'HH-mm'),
    datetime: format(date, 'yyyy-MM-dd_HH-mm-ss'), // Added a combined datetime
  };
}
