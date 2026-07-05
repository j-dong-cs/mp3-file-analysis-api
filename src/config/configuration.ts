/** Strongly-typed application config, loaded by `@nestjs/config`. */
export interface AppConfig {
  /** Port the HTTP server listens on. */
  port: number;
  /** Maximum accepted upload size in bytes (enforced mid-stream → 413). */
  maxUploadBytes: number;
}

/** Config keys — use these instead of magic strings with `ConfigService.get`. */
export const CONFIG_KEYS = {
  port: 'port',
  maxUploadBytes: 'maxUploadBytes',
} as const;

const DEFAULT_PORT = 3000;
const DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * Config factory consumed via `ConfigModule.forRoot({ load: [configuration] })`.
 * Reads and coerces env vars once at startup.
 */
export default (): AppConfig => ({
  port: Number(process.env.PORT ?? DEFAULT_PORT),
  maxUploadBytes: Number(
    process.env.MAX_UPLOAD_BYTES ?? DEFAULT_MAX_UPLOAD_BYTES,
  ),
});
