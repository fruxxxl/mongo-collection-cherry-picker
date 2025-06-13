export interface BackupArgs {
  selectedCollections: string[];
  excludedCollections: string[];
  mode: 'all' | 'include' | 'exclude';
  startTime?: Date;
}
