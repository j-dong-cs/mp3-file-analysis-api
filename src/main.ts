import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';

import { AppModule } from './app.module';
import { CONFIG_KEYS } from './config/configuration';

/**
 * Application entrypoint. Boots the Nest app and starts listening on the
 * configured port (via ConfigService, not process.env directly).
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService);
  const port = configService.get<number>(CONFIG_KEYS.port) ?? 3000;
  await app.listen(port);
}

void bootstrap();
