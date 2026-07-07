/** BullMQ queue name for MP3 analysis jobs. */
export const MP3_ANALYSIS_QUEUE = 'mp3-analysis';

/** Payload of an analysis job — just the id; the worker loads the rest from the DB. */
export interface AnalyzeUploadJob {
  uploadId: string;
}
