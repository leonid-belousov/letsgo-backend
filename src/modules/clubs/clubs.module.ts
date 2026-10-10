import { Module } from '@nestjs/common';
import { ClubMembersController, ClubsMeController } from './club-members.controller';
import { ClubMembersService } from './club-members.service';
import { ClubOwnershipService } from './club-ownership.service';
import { ClubsController } from './clubs.controller';
import { ClubsService } from './clubs.service';

@Module({
  controllers: [ClubsController, ClubMembersController, ClubsMeController],
  providers: [ClubsService, ClubMembersService, ClubOwnershipService],
  exports: [ClubsService, ClubMembersService],
})
export class ClubsModule {}
