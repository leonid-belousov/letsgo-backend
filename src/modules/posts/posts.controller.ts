import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiTags,
  ApiHeader,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentUser, OptionalUser, Public } from '../../common/auth/auth.decorators';
import type { AuthUser } from '../../common/auth/auth.types';
import { IdempotencyKey } from '../../common/idempotency/idempotency-key.decorator';
import { PageQuery } from '../../common/pagination/cursor-page';
import { CommentsService } from './comments.service';
import {
  CommentDto,
  CommentPageDto,
  CommentsQuery,
  CreateCommentDto,
  CreatePostDto,
  DecideTagDto,
  EditCommentDto,
  LikeStateDto,
  ListPostsQuery,
  PostDto,
  PostPageDto,
  SetCommentsClosedDto,
  TaggedPostsQuery,
  TagRequestDto,
  TagRequestPageDto,
  TagRequestsQuery,
  UpdatePostDto,
} from './dto';
import { PostsService } from './posts.service';
import { TagRequestsService } from './tag-requests.service';

@ApiTags('posts')
@ApiBearerAuth()
@Controller('posts')
export class PostsController {
  constructor(
    private readonly posts: PostsService,
    private readonly comments: CommentsService,
  ) {}

  @Post()
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiCreatedResponse({
    type: PostDto,
    description: 'Idempotent with Idempotency-Key: a retry returns the same post',
  })
  create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreatePostDto,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
  ) {
    return this.posts.create(user.userId, dto, key, String(req.id));
  }

  @Get('drafts')
  @ApiOkResponse({ type: PostPageDto, description: 'Your own drafts' })
  drafts(@CurrentUser() user: AuthUser, @Query() q: PageQuery) {
    return this.posts.listDrafts(user.userId, q);
  }

  @Public()
  @Get()
  @ApiOkResponse({
    type: PostPageDto,
    description: 'Posts of one author entity the viewer may see',
  })
  list(@OptionalUser() viewer: AuthUser | null, @Query() q: ListPostsQuery) {
    return this.posts.listByAuthor(viewer?.userId ?? null, q.authorType, q.authorEntityId, q);
  }

  @Public()
  @Get('tagged')
  @ApiOkResponse({ type: PostPageDto, description: 'Posts where the subject let the mention show' })
  tagged(@OptionalUser() viewer: AuthUser | null, @Query() q: TaggedPostsQuery) {
    return this.posts.listTagged(viewer?.userId ?? null, q.targetType, q.targetId, q);
  }

  @Public()
  @Get(':id')
  @ApiOkResponse({ type: PostDto })
  get(@OptionalUser() viewer: AuthUser | null, @Param('id', ParseUUIDPipe) id: string) {
    return this.posts.get(viewer?.userId ?? null, id);
  }

  @Patch(':id')
  @ApiOkResponse({ type: PostDto })
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePostDto,
  ) {
    return this.posts.update(user.userId, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiNoContentResponse({ description: 'Soft delete; idempotent' })
  async remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.posts.remove(user.userId, id);
  }

  @Post(':id/publish')
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @HttpCode(200)
  @ApiOkResponse({ type: PostDto, description: 'DRAFT → PUBLISHED; publishing twice is a no-op' })
  publish(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
  ) {
    return this.posts.publish(user.userId, id, key, String(req.id));
  }

  @Put(':id/comments-closed')
  @ApiOkResponse({ type: PostDto })
  closeComments(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetCommentsClosedDto,
  ) {
    return this.posts.setCommentsClosed(user.userId, id, dto.closed);
  }

  @Put(':id/like')
  @ApiOkResponse({ type: LikeStateDto, description: 'Idempotent' })
  like(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.posts.like(user.userId, id);
  }

  @Delete(':id/like')
  @ApiOkResponse({ type: LikeStateDto, description: 'Idempotent' })
  unlike(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.posts.unlike(user.userId, id);
  }

  @Public()
  @Get(':id/comments')
  @ApiOkResponse({ type: CommentPageDto })
  listComments(
    @OptionalUser() viewer: AuthUser | null,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: CommentsQuery,
  ) {
    return this.comments.list(viewer?.userId ?? null, id, q, q.parentId);
  }

  @Post(':id/comments')
  @ApiCreatedResponse({ type: CommentDto })
  comment(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateCommentDto,
  ) {
    return this.comments.create(user.userId, id, dto);
  }
}

@ApiTags('posts')
@ApiBearerAuth()
@Controller('comments')
export class CommentsController {
  constructor(private readonly comments: CommentsService) {}

  @Patch(':id')
  @ApiOkResponse({ type: CommentDto })
  edit(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EditCommentDto,
  ) {
    return this.comments.edit(user.userId, id, dto.body);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiNoContentResponse({ description: 'Author, post author or club moderator; idempotent' })
  async remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.comments.remove(user.userId, id);
  }
}

@ApiTags('posts')
@ApiBearerAuth()
@Controller('tag-requests')
export class TagRequestsController {
  constructor(private readonly tags: TagRequestsService) {}

  @Get()
  @ApiOkResponse({
    type: TagRequestPageDto,
    description: 'Mentions awaiting your review (yours + clubs you moderate)',
  })
  list(@CurrentUser() user: AuthUser, @Query() q: TagRequestsQuery) {
    return this.tags.listMine(user.userId, q.status ?? 'PENDING_REVIEW', q);
  }

  @Post(':id/decision')
  @HttpCode(200)
  @ApiOkResponse({
    type: TagRequestDto,
    description: 'SHOW / HIDE / REMOVE. The post is never deleted.',
  })
  decide(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DecideTagDto,
  ) {
    return this.tags.decide(user.userId, id, dto.decision);
  }
}
