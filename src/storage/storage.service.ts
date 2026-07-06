import {
  DeleteObjectCommand,
  GetObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Readable } from 'node:stream';

import { CONFIG_KEYS, S3Config } from '../config/configuration';

/**
 * Thin S3 client wrapper, pointed at MinIO in local dev (S3-compatible).
 * The only MinIO-specific bits are the custom `endpoint` and `forcePathStyle`;
 * flip those to real AWS in prod and the code is unchanged.
 */
@Injectable()
export class StorageService implements OnModuleDestroy {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(configService: ConfigService) {
    const s3 = configService.getOrThrow<S3Config>(CONFIG_KEYS.s3);
    this.bucket = s3.bucket;
    this.client = new S3Client({
      endpoint: s3.endpoint,
      region: s3.region,
      forcePathStyle: s3.forcePathStyle,
      credentials: {
        accessKeyId: s3.accessKeyId,
        secretAccessKey: s3.secretAccessKey,
      },
    });
  }

  /**
   * Stream a body into storage. Uses the managed multipart uploader, so large
   * (GB) streams upload in parts without buffering the whole thing in memory.
   */
  async putObject(
    key: string,
    body: Readable | Buffer,
    contentType?: string,
  ): Promise<void> {
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      },
    });
    await upload.done();
  }

  /** Open a readable stream for an object — the worker feeds this to the counter. */
  async getObjectStream(key: string): Promise<Readable> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    return response.Body as Readable;
  }

  /** Remove an object (used for cleanup / failed uploads). */
  async deleteObject(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  onModuleDestroy(): void {
    this.client.destroy();
  }
}
