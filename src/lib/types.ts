export type BacklogJob = {
  programId: string,
  actorId: string,
  startDate: Date;
  backlogTo: Date;
  complete: boolean;
}