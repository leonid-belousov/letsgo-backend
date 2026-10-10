import { Module } from '@nestjs/common';
import { CommentsService } from './comments.service';
import { MentionsService } from './mentions.service';
import { PostVisibilityService } from './post-visibility.service';
import { CommentsController, PostsController, TagRequestsController } from './posts.controller';
import { PostsService } from './posts.service';
import { TagRequestsService } from './tag-requests.service';

@Module({
  controllers: [PostsController, CommentsController, TagRequestsController],
  providers: [
    PostsService,
    CommentsService,
    MentionsService,
    PostVisibilityService,
    TagRequestsService,
  ],
  exports: [PostsService, PostVisibilityService, CommentsService],
})
export class PostsModule {}
