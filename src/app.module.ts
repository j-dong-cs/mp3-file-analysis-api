import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import configuration from './config/configuration';
import { FileUploadModule } from './file-upload/file-upload.module';

/** Root module — loads config globally and wires the feature modules. */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),
    FileUploadModule,
  ],
})
export class AppModule {}
