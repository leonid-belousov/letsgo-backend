import { Module } from '@nestjs/common';
import { PitchStructureService } from './pitch-structure.service';
import { VenueAccess } from './venue-access';
import { AdminVenueRequestsController, VenueRequestsController } from './venue-requests.controller';
import { VenueRequestsService } from './venue-requests.service';
import { PitchesController, VenuesController } from './venues.controller';
import { VenuesService } from './venues.service';

@Module({
  controllers: [
    VenuesController,
    PitchesController,
    VenueRequestsController,
    AdminVenueRequestsController,
  ],
  providers: [VenueAccess, VenuesService, PitchStructureService, VenueRequestsService],
  exports: [VenueAccess, VenuesService],
})
export class VenuesModule {}
