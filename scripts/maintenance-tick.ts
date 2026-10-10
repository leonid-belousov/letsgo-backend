/**
 * Runs the persistent maintenance job once and exits. Intended for an external scheduler
 * (cron, Kubernetes CronJob, …) when MAINTENANCE_INTERVAL_SECONDS=0 disables the built-in trigger.
 * Usage: npm run maintenance:tick
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { MaintenanceService } from '../src/modules/maintenance/maintenance.service';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const result = await app.get(MaintenanceService).runOnce();
    console.log(JSON.stringify(result));
  } finally {
    await app.close();
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
