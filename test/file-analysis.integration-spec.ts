import { BadRequestException } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { Request } from 'express';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { Repository } from 'typeorm';

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

/** Build a minimal multipart/form-data request stream for driving the service. */
function multipartRequest(
  fileBuf: Buffer,
  opts: { filename?: string; contentType?: string; boundary?: string } = {},
): Request {
  const filename = opts.filename ?? 'audio.mp3';
  const contentType = opts.contentType ?? 'audio/mpeg';
  const boundary = opts.boundary ?? `----jest${randomUUID()}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([head, fileBuf, tail]);
  const req = Readable.from([body]) as unknown as Request;
  (req as unknown as { headers: Record<string, string> }).headers = {
    'content-type': `multipart/form-data; boundary=${boundary}`,
    'content-length': String(body.length),
  };
  return req;
}

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
    const upload = await service.create({
      storageKey: key,
      contentType: 'audio/mpeg',
    });

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
    const upload = await service.create({
      storageKey: key,
      contentType: 'audio/mpeg',
    });

    await expect(service.processUpload(upload.id)).rejects.toBeDefined();

    const row = await service.findById(upload.id);
    expect(row?.status).toBe(FileUploadStatus.Failed);
    expect(row?.errorMessage).toMatch(/No MPEG audio frames/);

    await storage.deleteObject(key);
  });

  it('processes concurrent uploads with independent, correct counts', async () => {
    const counts = [7, 19, 33, 51, 80];
    const uploads = await Promise.all(
      counts.map(async (n) => {
        const key = `test/concurrent-${randomUUID()}.mp3`;
        await storage.putObject(key, buildStream(n), 'audio/mpeg');
        const upload = await service.create({ storageKey: key });
        return { id: upload.id, key, expected: n };
      }),
    );

    // Process them all at once — the per-upload counter must stay isolated.
    await Promise.all(uploads.map((u) => service.processUpload(u.id)));

    for (const u of uploads) {
      const row = await service.findById(u.id);
      expect(row?.status).toBe(FileUploadStatus.Done);
      expect(row?.frameCount).toBe(u.expected);
      await storage.deleteObject(u.key);
    }
  }, 30000);

  it('acceptLargeUpload rolls back the object and row when enqueue fails', async () => {
    const repo = moduleRef.get<Repository<FileUpload>>(
      getRepositoryToken(FileUpload),
      { strict: false },
    );
    const before = await repo.count();

    let capturedKey: string | undefined;
    const realPut = storage.putObject.bind(storage);
    const putSpy = jest
      .spyOn(storage, 'putObject')
      .mockImplementation((key, body, ct) => {
        capturedKey = key;
        return realPut(key, body, ct);
      });
    const enqueueSpy = jest
      .spyOn(service, 'enqueue')
      .mockRejectedValueOnce(new Error('redis unavailable'));

    await expect(
      service.acceptLargeUpload(multipartRequest(buildStream(10))),
    ).rejects.toBeDefined();

    // Nothing left orphaned: the created row is gone and the object is deleted.
    expect(await repo.count()).toBe(before);
    expect(capturedKey).toBeDefined();
    await expect(
      storage.getObjectStream(capturedKey as string),
    ).rejects.toBeDefined();

    putSpy.mockRestore();
    enqueueSpy.mockRestore();
  });

  it('acceptLargeUpload rejects a malformed multipart body with 400', async () => {
    const req = Readable.from(['not a multipart body']) as unknown as Request;
    (req as unknown as { headers: Record<string, string> }).headers = {
      'content-type': 'multipart/form-data', // no boundary → busboy throws
      'content-length': '20',
    };
    await expect(service.acceptLargeUpload(req)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
