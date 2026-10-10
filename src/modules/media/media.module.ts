import { Global, Module } from '@nestjs/common';
import { PostsModule } from '../posts/posts.module';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';
import { LocalDiskStorage, MediaStorage } from './storage';

/**
 * Global so clubs/venues/tournaments can inject MediaService (or import `assertOwnedReady`
 * from ./media-checks). Storage is TECH/dev (local disk); the production provider is OPEN.
 */
@Global()
@Module({
  imports: [PostsModule],
  controllers: [MediaController],
  providers: [MediaService, { provide: MediaStorage, useClass: LocalDiskStorage }],
  exports: [MediaService, MediaStorage],
})
export class MediaModule {}
