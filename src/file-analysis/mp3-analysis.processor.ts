import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';

import {
  AnalyzeUploadJob,
  MP3_ANALYSIS_QUEUE,
} from './file-analysis.constants';
import { FileAnalysisService } from './file-analysis.service';

/**
 * BullMQ worker. A thin adapter — it just calls the (already-tested)
 * `processUpload`. Run multiple app instances to scale workers horizontally;
 * BullMQ distributes jobs and retries failures across them.
 */
@Processor(MP3_ANALYSIS_QUEUE)
export class Mp3AnalysisProcessor extends WorkerHost {
  constructor(private readonly fileAnalysisService: FileAnalysisService) {
    super();
  }

  async process(job: Job<AnalyzeUploadJob>): Promise<void> {
    await this.fileAnalysisService.processUpload(job.data.uploadId);
  }
}
