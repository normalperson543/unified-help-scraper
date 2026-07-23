export type BacklogJob = {
  programId: string;
  actorId: string;
  startDate: Date;
  backlogFrom: Date;
  backlogTo: Date;
  finishDate?: Date;
  error?: string;
  ts: {
    start: string;
    current: string;
    end: string;
  };
};
export type StopJob = {
  programId: string;
  actorId: string;
  stopDate: Date;
};
