import { Module } from '@nestjs/common';
import { BookingsModule } from '../bookings/bookings.module';
import { GamesModule } from '../games/games.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { MaintenanceController } from './maintenance.controller';
import { MaintenanceService } from './maintenance.service';

@Module({
  imports: [GamesModule, BookingsModule, NotificationsModule],
  controllers: [MaintenanceController],
  providers: [MaintenanceService],
  exports: [MaintenanceService],
})
export class MaintenanceModule {}
