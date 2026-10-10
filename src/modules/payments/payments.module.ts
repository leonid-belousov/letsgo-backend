import { Module } from '@nestjs/common';
import { FeeAmendmentsController } from './fee-amendments.controller';
import { FeeAmendmentsService } from './fee-amendments.service';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

@Module({
  controllers: [PaymentsController, FeeAmendmentsController],
  providers: [PaymentsService, FeeAmendmentsService],
  exports: [PaymentsService, FeeAmendmentsService],
})
export class PaymentsModule {}
