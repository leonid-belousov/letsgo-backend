import { Global, Module } from '@nestjs/common';
import { PrivacyController } from './privacy.controller';
import { PrivacyService } from './privacy.service';
import { VisibilityService } from './visibility.service';

/** Global: every module that returns another person's data needs VisibilityService. */
@Global()
@Module({
  controllers: [PrivacyController],
  providers: [PrivacyService, VisibilityService],
  exports: [PrivacyService, VisibilityService],
})
export class PrivacyModule {}
