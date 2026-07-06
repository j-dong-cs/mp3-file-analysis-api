import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from './../src/app.module';
import { buildStream } from './../src/mp3/testing/mp3-fixtures';

describe('POST /file-upload (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns { frameCount } for a valid MPEG-1 Layer III file', async () => {
    const mp3 = buildStream(42);
    const res = await request(app.getHttpServer())
      .post('/file-upload')
      .attach('file', mp3, { filename: 'sample.mp3', contentType: 'audio/mpeg' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ frameCount: 42 });
  });

  it('returns 415 for a non-multipart request', async () => {
    const res = await request(app.getHttpServer())
      .post('/file-upload')
      .send({ not: 'multipart' });

    expect(res.status).toBe(415);
  });

  it('returns 415 for a non-mp3 file part', async () => {
    const res = await request(app.getHttpServer())
      .post('/file-upload')
      .attach('file', Buffer.from('hello world'), {
        filename: 'note.txt',
        contentType: 'text/plain',
      });

    expect(res.status).toBe(415);
  });

  it('returns 400 when no file part is present', async () => {
    const res = await request(app.getHttpServer())
      .post('/file-upload')
      .field('some', 'value');

    expect(res.status).toBe(400);
  });

  it('returns 422 for a multipart upload that is not real MP3 audio', async () => {
    const res = await request(app.getHttpServer())
      .post('/file-upload')
      .attach('file', Buffer.alloc(4096), {
        filename: 'fake.mp3',
        contentType: 'audio/mpeg',
      });

    expect(res.status).toBe(422);
  });
});

describe('POST /file-upload size limit (e2e)', () => {
  let app: INestApplication;
  const originalLimit = process.env.MAX_UPLOAD_BYTES;

  beforeAll(async () => {
    process.env.MAX_UPLOAD_BYTES = '1000'; // tiny limit for the test
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    process.env.MAX_UPLOAD_BYTES = originalLimit;
  });

  it('returns 413 when the file exceeds MAX_UPLOAD_BYTES', async () => {
    const big = buildStream(50); // ~20 KB, well over the 1000-byte limit
    const res = await request(app.getHttpServer())
      .post('/file-upload')
      .attach('file', big, { filename: 'big.mp3', contentType: 'audio/mpeg' });

    expect(res.status).toBe(413);
  });
});
