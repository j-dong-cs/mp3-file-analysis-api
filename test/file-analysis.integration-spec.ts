import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';

import configuration from '../src/config/configuration';
import { DatabaseModule } from '../src/database/database.module';
import { FileUploadStatus } from '../src/file-analysis/entities/file-upload.entity';
import { FileAnalysisModule } from '../src/file-analysis/file-analysis.module';
import { FileAnalysisService } from '../src/file-analysis/file-analysis.service';
import { buildStream } from '../src/mp3/testing/mp3-fixtures';
import { StorageService } from '../src/storage/storage.service';

/**
 * Integration test — requires the local stack (MinIO + Postgres):
 *   docker compose up -d && npm run test:integration
 *
 * Drives FileAnalysisService.processUpload() directly (no queue), so it's
 * deterministic: seed an object in MinIO + a row in Postgres, process, assert.
 */
describe('FileAnalysisService.processUpload (integration — needs MinIO + Postgres)', () => {
  let moduleRef: TestingModule;
  let service: FileAnalysisService;
  let storage: StorageService;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
        DatabaseModule,
        FileAnalysisModule,
      ],
    }).compile();
    service = moduleRef.get(FileAnalysisService, { strict: false });
    storage = moduleRef.get(StorageService, { strict: false });
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  it('streams a stored MP3 from S3, counts frames, and marks the row done', async () => {
    const key = `test/analyze-${randomUUID()}.mp3`;
    await storage.putObject(key, buildStream(42), 'audio/mpeg');
    const upload = await service.create({ storageKey: key, contentType: 'audio/mpeg' });

    await service.processUpload(upload.id);

    const row = await service.findById(upload.id);
    expect(row?.status).toBe(FileUploadStatus.Done);
    expect(row?.frameCount).toBe(42);
    expect(row?.completedAt).toBeInstanceOf(Date);

    await storage.deleteObject(key);
  });

  it('marks the row failed when the object is not valid MP3 audio', async () => {
    const key = `test/bad-${randomUUID()}.mp3`;
    await storage.putObject(key, Buffer.alloc(2048), 'audio/mpeg');
    const upload = await service.create({ storageKey: key, contentType: 'audio/mpeg' });

    await expect(service.processUpload(upload.id)).rejects.toBeDefined();

    const row = await service.findById(upload.id);
    expect(row?.status).toBe(FileUploadStatus.Failed);
    expect(row?.errorMessage).toMatch(/No MPEG audio frames/);

    await storage.deleteObject(key);
  });
});
