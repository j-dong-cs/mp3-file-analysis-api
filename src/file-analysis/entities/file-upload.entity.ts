import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/** Lifecycle of an async large-file upload. */
export enum FileUploadStatus {
  Pending = 'pending',
  Processing = 'processing',
  Done = 'done',
  Failed = 'failed',
}

/**
 * pg returns `bigint` as a string (to avoid precision loss). File sizes are
 * well within Number.MAX_SAFE_INTEGER, so we transform to a plain number.
 */
const bigintTransformer = {
  to: (value?: number | null): number | null | undefined => value,
  from: (value?: string | null): number | null =>
    value === null || value === undefined ? null : Number(value),
};

/**
 * Durable record of a large-file upload and its analysis result.
 * Job/queue state lives in Redis (BullMQ); the bytes live in MinIO/S3 — this
 * table holds only metadata + the frame count. See DB Design in the docs.
 */
@Entity('file_uploads')
@Index(['status'])
@Index(['createdAt'])
export class FileUpload {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Object key in MinIO/S3. Unique — one row per stored object. */
  @Column({ name: 'storage_key', type: 'varchar', length: 512, unique: true })
  storageKey!: string;

  @Column({ name: 'original_filename', type: 'varchar', length: 255, nullable: true })
  originalFilename!: string | null;

  @Column({ name: 'content_type', type: 'varchar', length: 128, nullable: true })
  contentType!: string | null;

  @Column({
    name: 'size_bytes',
    type: 'bigint',
    nullable: true,
    transformer: bigintTransformer,
  })
  sizeBytes!: number | null;

  @Column({
    type: 'enum',
    enum: FileUploadStatus,
    default: FileUploadStatus.Pending,
  })
  status!: FileUploadStatus;

  /** The result — null until status is `done`. */
  @Column({ name: 'frame_count', type: 'int', nullable: true })
  frameCount!: number | null;

  /** Populated when status is `failed`. */
  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage!: string | null;

  /** S3 ETag / content hash — enables idempotent re-processing. */
  @Column({ name: 'checksum_etag', type: 'varchar', length: 128, nullable: true })
  checksumEtag!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt!: Date | null;
}
