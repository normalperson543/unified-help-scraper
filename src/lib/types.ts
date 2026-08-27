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

export type FlaronUserResponse = {
  "data": {
    "user": {
      "id": string,
      "name": string,
      "real_name": string,
      "deleted": false,
      "tz": string,
      "tz_label": string,
      "tz_offset": number,
      "title": string,
      "phone": string,
      "display_name": string,
      "is_admin": boolean,
      "is_owner": boolean,
      "is_primary_owner": boolean,
      "is_restricted": boolean,
      "is_ultra_restricted": boolean,
      "is_bot"?: boolean
    },
    "idv_status": string,
    "fraud": string
  }
}