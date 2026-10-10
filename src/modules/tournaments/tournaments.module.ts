import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { BookingsModule } from '../bookings/bookings.module';
import { TournamentExtrasController } from './extras.controller';
import { TournamentBookingsService } from './tournament-bookings.service';
import { WithdrawalsService } from './withdrawals.service';
import { PaymentsModule } from '../payments/payments.module';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { EntriesController } from './entries.controller';
import { EntriesService } from './entries.service';
import { FixtureViewService } from './fixture-view.service';
import { ReadinessService } from './readiness.service';
import { ResultsService } from './results.service';
import { ScheduleService } from './schedule.service';
import { SponsorsController } from './sponsors.controller';
import { SponsorsService } from './sponsors.service';
import { StructureController } from './structure.controller';
import { StructureService } from './structure.service';
import { TournamentAccess } from './tournament-access.service';
import { TournamentViewService } from './tournament-view.service';
import { TournamentsController } from './tournaments.controller';
import { TournamentsService } from './tournaments.service';

@Module({
  imports: [PaymentsModule, AccessModule, BookingsModule],
  controllers: [
    TournamentsController,
    EntriesController,
    DocumentsController,
    SponsorsController,
    StructureController,
    TournamentExtrasController,
  ],
  providers: [
    TournamentAccess,
    ReadinessService,
    DocumentsService,
    TournamentViewService,
    FixtureViewService,
    ResultsService,
    StructureService,
    ScheduleService,
    EntriesService,
    SponsorsService,
    TournamentsService,
    TournamentBookingsService,
    WithdrawalsService,
  ],
  exports: [TournamentsService, TournamentAccess],
})
export class TournamentsModule {}
