import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { AppModule } from './../src/app.module';

describe('FileUpload (e2e)', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('bootstraps the application', () => {
    expect(app).toBeDefined();
  });

  // Enable once the controller/service are implemented:
  it.todo('POST /file-upload returns 415 for a non-multipart request');
  it.todo(
    'POST /file-upload returns { frameCount } for a valid MPEG-1 Layer III file',
  );
  it.todo(
    'POST /file-upload returns 413 when the file exceeds MAX_UPLOAD_BYTES',
  );
});
