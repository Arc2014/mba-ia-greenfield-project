import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker/worker.module';

/**
 * Entrypoint for the `video-worker` Compose service (per phase-03 TD-04): a
 * standalone Nest application context that registers the BullMQ `@Processor`.
 * No HTTP server — the BullMQ worker keeps the process alive on the Redis
 * connection.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
  Logger.log('Consuming the video-processing queue', 'VideoWorker');
}

void bootstrap();
