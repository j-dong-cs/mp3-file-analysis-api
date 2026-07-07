import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { Readable } from 'node:stream';

import configuration from '../src/config/configuration';
import { StorageModule } from '../src/storage/storage.module';
import { StorageService } from '../src/storage/storage.service';

/**
 * Integration test — requires the local stack (MinIO) to be running:
 *   docker compose up -d && npm run test:integration
 */
async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

describe('StorageService (integration — needs MinIO)', () => {
  let moduleRef: TestingModule;
  let storage: StorageService;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
        StorageModule,
      ],
    }).compile();
    storage = moduleRef.get(StorageService);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  it('round-trips a Buffer (put → getStream → identical bytes)', async () => {
    const key = `test/roundtrip-${Date.now()}.bin`;
    const payload = Buffer.from('hello minio streaming world');

    await storage.putObject(key, payload, 'application/octet-stream');
    const out = await readAll(await storage.getObjectStream(key));

    expect(out.equals(payload)).toBe(true);
    await storage.deleteObject(key);
  });

  it('streams a 5 MB body through the managed uploader intact', async () => {
    const key = `test/large-${Date.now()}.bin`;
    const payload = Buffer.alloc(5 * 1024 * 1024, 0x07);

    await storage.putObject(
      key,
      Readable.from(payload),
      'application/octet-stream',
    );
    const out = await readAll(await storage.getObjectStream(key));

    expect(out.length).toBe(payload.length);
    expect(out.equals(payload)).toBe(true);
    await storage.deleteObject(key);
  });
});
