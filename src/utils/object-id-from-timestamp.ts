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
