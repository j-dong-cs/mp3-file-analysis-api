import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { Queue, Worker } from 'bullmq';
import { randomUUID } from 'node:crypto';

import configuration, { RedisConfig } from '../src/config/configuration';
import { DatabaseModule } from '../src/database/database.module';
import { FileUploadStatus } from '../src/file-analysis/entities/file-upload.entity';
import {
  AnalyzeUploadJob,
  MP3_ANALYSIS_QUEUE,
} from '../src/file-analysis/file-analysis.constants';
import { FileAnalysisModule } from '../src/file-analysis/file-analysis.module';
import { FileAnalysisService } from '../src/file-analysis/file-analysis.service';
import { buildStream } from '../src/mp3/testing/mp3-fixtures';
import { StorageService } from '../src/storage/storage.service';

/**
 * Formalized horizontal-scaling test — requires MinIO + Postgres + Redis.
 *
 * Spins up N BullMQ workers over the real `processUpload`, enqueues M jobs, and
 * asserts every job completes and the work is distributed across all N workers.
 * The module is compiled but NOT initialized, so the app's own @Processor worker
 * doesn't start — the test owns exactly N workers and can tally who did what.
 */
const WORKERS = 4;
const JOBS = 20;
const FRAMES = 15;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe('Horizontal scaling (integration — needs MinIO + Postgres + Redis)', () => {
  let moduleRef: TestingModule;
  let service: FileAnalysisService;
  let storage: StorageService;
  let queue: Queue;
  const workers: Worker[] = [];
  const perWorker: number[] = new Array(WORKERS).fill(0);
  const keys: string[] = [];

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
        DatabaseModule,
        FileAnalysisModule,
      ],
    }).compile(); // compile only → the app's built-in worker does NOT start
    service = moduleRef.get(FileAnalysisService, { strict: false });
    storage = moduleRef.get(StorageService, { strict: false });
    queue = moduleRef.get<Queue>(getQueueToken(MP3_ANALYSIS_QUEUE), {
      strict: false,
    });
    await queue.obliterate({ force: true }); // clear any leftover jobs

    const redis = moduleRef
      .get(ConfigService)
      .getOrThrow<RedisConfig>('redis');
    for (let idx = 0; idx < WORKERS; idx++) {
      workers.push(
        new Worker<AnalyzeUploadJob>(
          MP3_ANALYSIS_QUEUE,
          async (job) => {
            perWorker[idx] += 1;
            await sleep(25); // simulate work so jobs spread across all workers
            await service.processUpload(job.data.uploadId);
          },
          { connection: { host: redis.host, port: redis.port }, concurrency: 1 },
        ),
      );
    }
    await Promise.all(workers.map((w) => w.waitUntilReady()));
  }, 30000);

  afterAll(async () => {
    await Promise.all(workers.map((w) => w.close()));
    await Promise.all(keys.map((k) => storage.deleteObject(k).catch(() => undefined)));
    await moduleRef.close();
  });

  it(`distributes ${JOBS} jobs across ${WORKERS} workers and completes them all`, async () => {
    const ids: string[] = [];
    for (let i = 0; i < JOBS; i++) {
      const key = `test/scale-${randomUUID()}.mp3`;
      keys.push(key);
      await storage.putObject(key, buildStream(FRAMES), 'audio/mpeg');
      const upload = await service.create({ storageKey: key });
      ids.push(upload.id);
    }
    await Promise.all(ids.map((id) => service.enqueue(id)));

    const deadline = Date.now() + 25000;
    let done = 0;
    while (Date.now() < deadline) {
      const rows = await Promise.all(ids.map((id) => service.findById(id)));
      done = rows.filter((r) => r?.status === FileUploadStatus.Done).length;
      if (done === JOBS) break;
      await sleep(200);
    }

    const total = perWorker.reduce((a, b) => a + b, 0);
    // eslint-disable-next-line no-console
    console.log(
      `  ${JOBS} jobs across ${WORKERS} workers → distribution [${perWorker.join(', ')}] (total ${total})`,
    );

    expect(done).toBe(JOBS); // every job completed
    expect(total).toBe(JOBS); // no lost/stolen jobs
    for (const count of perWorker) {
      expect(count).toBeGreaterThan(0); // every worker participated
    }
  }, 40000);
});
