import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import {
  LogDeliveryProvider,
  NotificationDeliveryProvider,
  NotificationsService,
} from './notifications.service';

@Module({
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    // Push vendor is an OPEN product decision: dev/log provider only.
    { provide: NotificationDeliveryProvider, useClass: LogDeliveryProvider },
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
