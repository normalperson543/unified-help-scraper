export type BacklogJob = {
  programId: string,
  actorId: string,
  startDate: Date;
  backlogFrom: Date;
  backlogTo: Date;
  finishDate?: Date;
  error?: string;
}