import { UnprocessableEntityException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { Mp3AnalyzeService } from './mp3-analyze.service';
import { buildStream, pushInChunks } from './testing/mp3-fixtures';

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

  it('createFrameCounter returns a counter with push() and end()', () => {
    const counter = service.createFrameCounter();
    expect(typeof counter.feed).toBe('function');
    expect(typeof counter.finalize).toBe('function');
  });

  it('hands out an isolated counter per call (no shared state)', () => {
    const a = service.createFrameCounter();
    const b = service.createFrameCounter();
    expect(a).not.toBe(b);

    a.feed(buildStream(3));
    b.feed(buildStream(7));
    expect(a.finalize()).toBe(3);
    expect(b.finalize()).toBe(7);
  });

  it('counts frames for a known CBR MPEG-1 Layer III buffer', () => {
    const counter = service.createFrameCounter();
    counter.feed(buildStream(20));
    expect(counter.finalize()).toBe(20);
  });

  it('yields the same count for one chunk vs many small chunks', () => {
    const buf = buildStream(25);

    const whole = service.createFrameCounter();
    whole.feed(buf);

    const chunked = service.createFrameCounter();
    pushInChunks(chunked, buf, 32);

    expect(whole.finalize()).toBe(25);
    expect(chunked.finalize()).toBe(25);
  });

  it('end() throws 422 when no frames were found', () => {
    const counter = service.createFrameCounter();
    counter.feed(Buffer.alloc(1024));
    expect(() => counter.finalize()).toThrow(UnprocessableEntityException);
  });
});
