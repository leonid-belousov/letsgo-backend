import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseEnumPipe,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiNoContentResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { FavouriteTargetType, FollowTargetType } from '@prisma/client';
import { CurrentUser, OptionalUser, Public } from '../../common/auth/auth.decorators';
import type { AuthUser } from '../../common/auth/auth.types';
import { PageQuery } from '../../common/pagination/cursor-page';
import { DiscoveryService } from './discovery.service';
import {
  DiscoveryQuery,
  FavouritePageDto,
  FavouritesQuery,
  FavouriteStateDto,
  FeedPageDto,
  FollowCountsDto,
  FollowerPageDto,
  FollowingPageDto,
  FollowRequestPageDto,
  FollowRequestsQuery,
  FollowStateDto,
  RemoveFollowerQuery,
  SavedPostPageDto,
  SavedStateDto,
} from './dto';
import { FavouritesService } from './favourites.service';
import { FollowsService } from './follows.service';

@ApiTags('social')
@ApiBearerAuth()
@Controller()
export class SocialController {
  constructor(
    private readonly follows: FollowsService,
    private readonly favourites: FavouritesService,
    private readonly discovery: DiscoveryService,
  ) {}

  // ───────── follow ─────────

  @Get('follows/requests')
  @ApiOkResponse({
    type: FollowRequestPageDto,
    description: 'Pending requests to follow you, or a club you approve for (?clubId=)',
  })
  requests(@CurrentUser() user: AuthUser, @Query() q: FollowRequestsQuery) {
    return this.follows.listRequests(user.userId, q, q.clubId);
  }

  @Post('follows/requests/:followId/accept')
  @HttpCode(200)
  @ApiOkResponse({ type: FollowStateDto })
  accept(@CurrentUser() user: AuthUser, @Param('followId', ParseUUIDPipe) followId: string) {
    return this.follows.respond(user.userId, followId, true);
  }

  @Post('follows/requests/:followId/decline')
  @HttpCode(200)
  @ApiOkResponse({ type: FollowStateDto })
  decline(@CurrentUser() user: AuthUser, @Param('followId', ParseUUIDPipe) followId: string) {
    return this.follows.respond(user.userId, followId, false);
  }

  @Delete('follows/followers/:followerId')
  @HttpCode(204)
  @ApiNoContentResponse({ description: 'Remove a follower (idempotent)' })
  async removeFollower(
    @CurrentUser() user: AuthUser,
    @Param('followerId', ParseUUIDPipe) followerId: string,
    @Query() q: RemoveFollowerQuery,
  ) {
    await this.follows.removeFollower(user.userId, followerId, q.clubId);
  }

  @Put('follows/:targetType/:targetId')
  @ApiOkResponse({
    type: FollowStateDto,
    description: 'Idempotent. Public target → ACCEPTED; private profile/club → REQUESTED.',
  })
  follow(
    @CurrentUser() user: AuthUser,
    @Param('targetType', new ParseEnumPipe(FollowTargetType)) targetType: FollowTargetType,
    @Param('targetId', ParseUUIDPipe) targetId: string,
  ) {
    return this.follows.follow(user.userId, targetType, targetId);
  }

  @Delete('follows/:targetType/:targetId')
  @ApiOkResponse({
    type: FollowStateDto,
    description: 'Unfollow or cancel a pending request (idempotent)',
  })
  unfollow(
    @CurrentUser() user: AuthUser,
    @Param('targetType', new ParseEnumPipe(FollowTargetType)) targetType: FollowTargetType,
    @Param('targetId', ParseUUIDPipe) targetId: string,
  ) {
    return this.follows.unfollow(user.userId, targetType, targetId);
  }

  @Get('follows/:targetType/:targetId')
  @ApiOkResponse({ type: FollowStateDto })
  followState(
    @CurrentUser() user: AuthUser,
    @Param('targetType', new ParseEnumPipe(FollowTargetType)) targetType: FollowTargetType,
    @Param('targetId', ParseUUIDPipe) targetId: string,
  ) {
    return this.follows.state(user.userId, targetType, targetId);
  }

  @Public()
  @Get('users/:id/followers')
  @ApiOkResponse({ type: FollowerPageDto, description: 'Honours the owner’s followListAudience' })
  followers(
    @OptionalUser() viewer: AuthUser | null,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: PageQuery,
  ) {
    return this.follows.followers(viewer?.userId ?? null, id, q);
  }

  @Public()
  @Get('users/:id/following')
  @ApiOkResponse({ type: FollowingPageDto })
  following(
    @OptionalUser() viewer: AuthUser | null,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: PageQuery,
  ) {
    return this.follows.following(viewer?.userId ?? null, id, q);
  }

  @Public()
  @Get('users/:id/follow-counts')
  @ApiOkResponse({ type: FollowCountsDto, description: 'A hidden list also hides the counters' })
  counts(@OptionalUser() viewer: AuthUser | null, @Param('id', ParseUUIDPipe) id: string) {
    return this.follows.counts(viewer?.userId ?? null, id);
  }

  // ───────── favourites ─────────

  @Get('favourites')
  @ApiOkResponse({
    type: FavouritePageDto,
    description:
      'Tabs all/people/clubs/events/places; inaccessible targets come back as neutral {unavailable:true}',
  })
  listFavourites(@CurrentUser() user: AuthUser, @Query() q: FavouritesQuery) {
    return this.favourites.list(user.userId, q);
  }

  @Put('favourites/:targetType/:targetId')
  @ApiOkResponse({
    type: FavouriteStateDto,
    description: 'Private; never notifies the target; independent of follow/membership',
  })
  addFavourite(
    @CurrentUser() user: AuthUser,
    @Param('targetType', new ParseEnumPipe(FavouriteTargetType)) targetType: FavouriteTargetType,
    @Param('targetId', ParseUUIDPipe) targetId: string,
  ) {
    return this.favourites.add(user.userId, targetType, targetId);
  }

  @Delete('favourites/:targetType/:targetId')
  @ApiOkResponse({ type: FavouriteStateDto })
  removeFavourite(
    @CurrentUser() user: AuthUser,
    @Param('targetType', new ParseEnumPipe(FavouriteTargetType)) targetType: FavouriteTargetType,
    @Param('targetId', ParseUUIDPipe) targetId: string,
  ) {
    return this.favourites.remove(user.userId, targetType, targetId);
  }

  @Get('favourites/:targetType/:targetId')
  @ApiOkResponse({ type: FavouriteStateDto })
  favouriteState(
    @CurrentUser() user: AuthUser,
    @Param('targetType', new ParseEnumPipe(FavouriteTargetType)) targetType: FavouriteTargetType,
    @Param('targetId', ParseUUIDPipe) targetId: string,
  ) {
    return this.favourites.state(user.userId, targetType, targetId);
  }

  // ───────── saved posts ─────────

  @Get('me/saved-posts')
  @ApiOkResponse({
    type: SavedPostPageDto,
    description: 'Posts you can no longer view are returned as neutral {unavailable:true}',
  })
  saved(@CurrentUser() user: AuthUser, @Query() q: PageQuery) {
    return this.favourites.listSaved(user.userId, q);
  }

  @Put('posts/:id/save')
  @ApiOkResponse({ type: SavedStateDto, description: 'Idempotent' })
  save(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.favourites.savePost(user.userId, id);
  }

  @Delete('posts/:id/save')
  @ApiOkResponse({ type: SavedStateDto, description: 'Idempotent' })
  unsave(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.favourites.unsavePost(user.userId, id);
  }

  // ───────── discovery ─────────

  @Get('discovery/for-you')
  @ApiOkResponse({
    type: FeedPageDto,
    description:
      'Newest-first visible posts with explainable reasons (no scores). category people/clubs/tournaments/pitches returns recommended entities. nextCursor=null → "You’re all caught up".',
  })
  forYou(@CurrentUser() user: AuthUser, @Query() q: DiscoveryQuery) {
    return this.discovery.forYou(user.userId, q.category ?? 'all', q);
  }

  @Get('discovery/following')
  @ApiOkResponse({
    type: FeedPageDto,
    description: 'Posts by followed users/clubs/venues/tournaments, newest first',
  })
  followingFeed(@CurrentUser() user: AuthUser, @Query() q: DiscoveryQuery) {
    return this.discovery.following(user.userId, q.category ?? 'all', q);
  }
}
