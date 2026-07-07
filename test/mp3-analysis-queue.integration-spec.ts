import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';

import configuration from '../src/config/configuration';
import { DatabaseModule } from '../src/database/database.module';
import {
  FileUpload,
  FileUploadStatus,
} from '../src/file-analysis/entities/file-upload.entity';
import { FileAnalysisModule } from '../src/file-analysis/file-analysis.module';
import { FileAnalysisService } from '../src/file-analysis/file-analysis.service';
import { buildStream } from '../src/mp3/testing/mp3-fixtures';
import { StorageService } from '../src/storage/storage.service';

/**
 * Integration test — requires MinIO + Postgres + Redis:
 *   docker compose up -d && npm run test:integration
 *
 * Boots a real Nest app so the BullMQ worker starts, enqueues a job, and polls
 * the DB until the worker has processed it: queue → worker → DB.
 */
async function waitForStatus(
  service: FileAnalysisService,
  id: string,
  statuses: FileUploadStatus[],
  timeoutMs: number,
): Promise<FileUpload> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await service.findById(id);
    if (row && statuses.includes(row.status)) return row;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for upload ${id}`);
}

describe('MP3 analysis queue (integration — needs MinIO + Postgres + Redis)', () => {
  let app: INestApplication;
  let service: FileAnalysisService;
  let storage: StorageService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
        DatabaseModule,
        FileAnalysisModule,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init(); // starts the BullMQ worker
    service = app.get(FileAnalysisService, { strict: false });
    storage = app.get(StorageService, { strict: false });
  }, 30000);

  afterAll(async () => {
    await app.close();
  });

  it('processes an enqueued job end-to-end: queue → worker → DB done', async () => {
    const key = `test/queue-${randomUUID()}.mp3`;
    await storage.putObject(key, buildStream(30), 'audio/mpeg');
    const upload = await service.create({
      storageKey: key,
      contentType: 'audio/mpeg',
    });

    await service.enqueue(upload.id);

    const row = await waitForStatus(
      service,
      upload.id,
      [FileUploadStatus.Done],
      15000,
    );
    expect(row.frameCount).toBe(30);

    await storage.deleteObject(key);
  }, 20000);
});
