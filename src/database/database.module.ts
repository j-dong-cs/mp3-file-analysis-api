import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CONFIG_KEYS, DbConfig } from '../config/configuration';

/**
 * Owns the database connection. Isolated so that features/tests which don't
 * touch the DB never open a connection — only modules that import this (or the
 * full AppModule) require Postgres to be running.
 *
 * `autoLoadEntities` picks up entities registered via `TypeOrmModule.forFeature`
 * in feature modules (e.g. FileAnalysisModule), so entities live with their feature.
 */
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const db = configService.getOrThrow<DbConfig>(CONFIG_KEYS.db);
        return {
          type: 'postgres',
          host: db.host,
          port: db.port,
          username: db.username,
          password: db.password,
          database: db.database,
          autoLoadEntities: true,
          synchronize: db.synchronize, // DEV ONLY (env-gated) — creates tables
        };
      },
    }),
  ],
})
export class DatabaseModule {}
