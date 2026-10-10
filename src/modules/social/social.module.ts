import { Module } from '@nestjs/common';
import { PostsModule } from '../posts/posts.module';
import { DiscoveryService } from './discovery.service';
import { EntityResolver } from './entity-resolver.service';
import { FavouritesService } from './favourites.service';
import { FollowsService } from './follows.service';
import { SocialController } from './social.controller';

@Module({
  imports: [PostsModule],
  controllers: [SocialController],
  providers: [FollowsService, FavouritesService, DiscoveryService, EntityResolver],
  exports: [FollowsService, EntityResolver],
})
export class SocialModule {}
