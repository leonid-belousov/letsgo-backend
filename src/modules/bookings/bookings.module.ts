import { Module } from '@nestjs/common';
import { BookingsController, PitchCalendarController } from './bookings.controller';
import { BookingsService } from './bookings.service';

@Module({
  controllers: [BookingsController, PitchCalendarController],
  providers: [BookingsService],
  exports: [BookingsService],
})
export class BookingsModule {}
