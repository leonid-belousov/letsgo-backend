import { Module } from '@nestjs/common';
import { MatchViewService } from './match-view.service';
import { MvpService } from './mvp.service';
import { ResultsController, UserStatsController } from './results.controller';
import { ResultsService } from './results.service';
import { StatsService } from './stats.service';

@Module({
  controllers: [ResultsController, UserStatsController],
  providers: [ResultsService, MatchViewService, MvpService, StatsService],
  exports: [ResultsService, StatsService, MvpService],
})
export class ResultsModule {}
