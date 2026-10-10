import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module';
import { GameViewService } from './game-view.service';
import { GamesController } from './games.controller';
import { GamesService } from './games.service';
import { InvitationsService } from './invitations.service';
import { GamesMaintenanceService } from './maintenance.service';
import { ParticipationService } from './participation.service';

@Module({
  imports: [PaymentsModule],
  controllers: [GamesController],
  providers: [
    GamesService,
    ParticipationService,
    InvitationsService,
    GameViewService,
    GamesMaintenanceService,
  ],
  exports: [
    GamesService,
    ParticipationService,
    InvitationsService,
    GameViewService,
    GamesMaintenanceService,
  ],
})
export class GamesModule {}
