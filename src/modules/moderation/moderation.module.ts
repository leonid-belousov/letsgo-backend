import { Module } from '@nestjs/common';
import { PostsModule } from '../posts/posts.module';
import { ModerationController } from './moderation.controller';
import { ModerationService } from './moderation.service';
import { ReportTargets } from './report-targets';

@Module({
  imports: [PostsModule],
  controllers: [ModerationController],
  providers: [ModerationService, ReportTargets],
  exports: [ModerationService],
})
export class ModerationModule {}
