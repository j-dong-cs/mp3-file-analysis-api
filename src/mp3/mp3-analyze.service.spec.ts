import { Test, TestingModule } from '@nestjs/testing';

import { Mp3AnalyzeService } from './mp3-analyze.service';

describe('Mp3AnalyzeService', () => {
  let service: Mp3AnalyzeService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [Mp3AnalyzeService],
    }).compile();

    service = module.get<Mp3AnalyzeService>(Mp3AnalyzeService);
  });

  it('is defined', () => {
    expect(service).toBeDefined();
  });

  // Enable once createFrameCounter is implemented:
  it.todo('createFrameCounter returns a counter with push() and end()');
  it.todo('counts frames for a known CBR MPEG-1 Layer III buffer');
  it.todo('yields the same count for one chunk vs many small chunks');
  it.todo('end() throws when no frames were found');
});
