export type BacklogJob = {
  programId: string;
  actorId: string;
  startDate: Date;
  backlogFrom: Date;
  backlogTo: Date;
  finishDate?: Date;
  error?: string;
};
export type StopJob = {
  programId: string;
  actorId: string;
  stopDate: Date;
};
