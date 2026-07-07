import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from './../src/app.module';
import { buildStream } from './../src/mp3/testing/mp3-fixtures';

/**
 * Endpoint e2e — boots the full app, so it needs the local stack
 * (MinIO + Postgres + Redis): `docker compose up -d && npm run test:e2e`.
 *
 * Covers both branches of POST /file-upload (small → sync 200, large → async
 * 202 + poll) plus the error paths.
 */
describe('POST /file-upload (e2e — needs the local stack)', () => {
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    // listen on an ephemeral port so concurrent requests don't race supertest's
    // lazy per-request listen (which caused ECONNRESET under parallel load)
    await app.listen(0);
    server = app.getHttpServer();
  }, 30000);

  afterAll(async () => {
    await app.close();
  });

  // ── sync branch (small files) ──────────────────────────────────────────
  it('small file → 200 { frameCount }', async () => {
    const res = await request(server)
      .post('/file-upload')
      .attach('file', buildStream(42), {
        filename: 'sample.mp3',
        contentType: 'audio/mpeg',
      });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ frameCount: 42 });
  });

  it('non-multipart → 415', async () => {
    const res = await request(server).post('/file-upload').send({ x: 1 });
    expect(res.status).toBe(415);
  });

  it('non-mp3 part → 415', async () => {
    const res = await request(server)
      .post('/file-upload')
      .attach('file', Buffer.from('hi'), {
        filename: 'note.txt',
        contentType: 'text/plain',
      });
    expect(res.status).toBe(415);
  });

  it('no file part → 400', async () => {
    const res = await request(server).post('/file-upload').field('x', 'y');
    expect(res.status).toBe(400);
  });

  it('small non-audio bytes → 422', async () => {
    const res = await request(server)
      .post('/file-upload')
      .attach('file', Buffer.alloc(4096), {
        filename: 'fake.mp3',
        contentType: 'audio/mpeg',
      });
    expect(res.status).toBe(422);
  });

  it('malformed multipart body → 400 (not 500)', async () => {
    // multipart/form-data content-type but no boundary → busboy throws
    const res = await request(server)
      .post('/file-upload')
      .set('Content-Type', 'multipart/form-data')
      .send('this is not a valid multipart body');
    expect(res.status).toBe(400);
  });

  it('concurrent uploads get independent, correct counts (no shared state)', async () => {
    // Distinct frame counts fired simultaneously — any shared per-request state
    // in the counter/service would cross-contaminate the results.
    const counts = [5, 11, 17, 23, 42, 63, 88, 111, 150, 200, 256, 320];
    const responses = await Promise.all(
      counts.map((n) =>
        request(server)
          .post('/file-upload')
          .attach('file', buildStream(n), {
            filename: `concurrent-${n}.mp3`,
            contentType: 'audio/mpeg',
          }),
      ),
    );
    responses.forEach((res, i) => {
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ frameCount: counts[i] });
    });
  }, 20000);

  // ── async branch (large files) ─────────────────────────────────────────
  it('large file → 202, then GET /:id resolves to done', async () => {
    const big = buildStream(63000); // ~26.3 MB, over the 25 MB threshold
    const accepted = await request(server)
      .post('/file-upload')
      .attach('file', big, { filename: 'big.mp3', contentType: 'audio/mpeg' });

    expect(accepted.status).toBe(202);
    expect(typeof accepted.body.uploadId).toBe('string');
    const id = accepted.body.uploadId;

    let body: { status: string; frameCount: number | null } | undefined;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const res = await request(server).get(`/file-upload/${id}`);
      body = res.body;
      if (body?.status === 'done' || body?.status === 'failed') break;
      await new Promise((r) => setTimeout(r, 200));
    }

    expect(body?.status).toBe('done');
    expect(body?.frameCount).toBe(63000);
  }, 40000);

  it('GET unknown id → 404', async () => {
    const res = await request(server).get(
      '/file-upload/00000000-0000-0000-0000-000000000000',
    );
    expect(res.status).toBe(404);
  });
});
