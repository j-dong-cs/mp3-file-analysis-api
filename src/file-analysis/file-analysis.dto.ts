import { FileUploadStatus } from './entities/file-upload.entity';

/** 202 response when a large file upload is accepted for async processing. */
export interface BigFileUploadResponse {
  uploadId: string;
  status: FileUploadStatus;
  statusUrl: string;
}

/** Response for GET /file-upload/:id. */
export interface UploadStatusResponse {
  id: string;
  status: FileUploadStatus;
  frameCount: number | null;
  errorMessage: string | null;
}
