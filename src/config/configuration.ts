/** Object storage (MinIO / S3) connection config. */
export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Required for MinIO (host/bucket/key addressing). */
  forcePathStyle: boolean;
}

/** Redis connection config (BullMQ backing store). */
export interface RedisConfig {
  host: string;
  port: number;
}

/** PostgreSQL connection config. */
export interface DbConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
  /** DEV ONLY: auto-create/update schema from entities. Use migrations in prod. */
  synchronize: boolean;
}

/** Strongly-typed application config, loaded by `@nestjs/config`. */
export interface AppConfig {
  /** Port the HTTP server listens on. */
  port: number;
  /** Maximum accepted upload size in bytes (enforced mid-stream → 413). */
  maxUploadBytes: number;
  s3: S3Config;
  redis: RedisConfig;
  db: DbConfig;
}

/** Config keys — use these instead of magic strings with `ConfigService.get`. */
export const CONFIG_KEYS = {
  port: 'port',
  maxUploadBytes: 'maxUploadBytes',
  s3: 's3',
  redis: 'redis',
  db: 'db',
} as const;

const DEFAULT_PORT = 3000;
const DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** Parse a boolean env var, defaulting when unset. */
function parseBoolEnv(value: string | undefined, fallback: boolean): boolean {
  return value === undefined ? fallback : value.toLowerCase() === 'true';
}

/**
 * Config factory consumed via `ConfigModule.forRoot({ load: [configuration] })`.
 * Reads and coerces env vars once at startup. Defaults match docker-compose.yml,
 * so the app connects to the local stack even without a .env file.
 */
export default (): AppConfig => ({
  port: Number(process.env.PORT ?? DEFAULT_PORT),
  maxUploadBytes: Number(
    process.env.MAX_UPLOAD_BYTES ?? DEFAULT_MAX_UPLOAD_BYTES,
  ),
  s3: {
    endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
    region: process.env.S3_REGION ?? 'us-east-1',
    bucket: process.env.S3_BUCKET ?? 'mp3-uploads',
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? 'minioadmin',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? 'minioadmin',
    forcePathStyle: parseBoolEnv(process.env.S3_FORCE_PATH_STYLE, true),
  },
  redis: {
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
  },
  db: {
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 5432),
    username: process.env.DB_USER ?? 'mp3',
    password: process.env.DB_PASSWORD ?? 'mp3',
    database: process.env.DB_NAME ?? 'mp3',
    synchronize: parseBoolEnv(process.env.DB_SYNCHRONIZE, true),
  },
});
