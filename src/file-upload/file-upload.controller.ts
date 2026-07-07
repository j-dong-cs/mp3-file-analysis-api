import {
  Controller,
  Get,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { FileValidator } from '../common/file.validator';
import {
  BigFileUploadResponse,
  UploadStatusResponse,
} from '../file-analysis/file-analysis.dto';
import { FileAnalysisService } from '../file-analysis/file-analysis.service';
import { FileUploadService } from './file-upload.service';

export interface FrameCountResponse {
  frameCount: number;
}

/**
 * `POST /file-upload` — one endpoint, two strategies, chosen by Content-Length:
 *   - ≤ threshold: stream + count in-request → `200 { frameCount }`
 *   - > threshold (or unknown length): stream to storage + enqueue → `202 { uploadId, statusUrl }`
 *
 * `GET /file-upload/:id` returns the async result once the worker finishes.
 * Errors propagate as Nest HttpExceptions → 400 / 413 / 415 / 422 / 404.
 */
@Controller('file-upload')
export class FileUploadController {
  constructor(
    private readonly fileValidator: FileValidator,
    private readonly fileUploadService: FileUploadService,
    private readonly fileAnalysisService: FileAnalysisService,
  ) {}

  @Post()
  async fileUpload(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<FrameCountResponse | BigFileUploadResponse> {
    this.fileValidator.assertMultipart(request);

    const contentLength = Number(request.headers['content-length']);
    const isSmallFile =
      Number.isFinite(contentLength) &&
      contentLength <= this.fileValidator.maxBytes;

    if (isSmallFile) {
      const frameCount =
        await this.fileUploadService.countFramesWhileUpload(request);
      response.status(HttpStatus.OK);
      return { frameCount };
    }

    const result = await this.fileAnalysisService.acceptLargeUpload(request);
    response.status(HttpStatus.ACCEPTED);
    return result;
  }

  @Get(':id')
  async status(@Param('id') id: string): Promise<UploadStatusResponse> {
    const upload = await this.fileAnalysisService.findById(id);
    if (!upload) {
      throw new NotFoundException(`Upload ${id} not found`);
    }
    return {
      id: upload.id,
      status: upload.status,
      frameCount: upload.frameCount,
      errorMessage: upload.errorMessage,
    };
  }
}
