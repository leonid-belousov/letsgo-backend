import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser, OptionalUser, Public } from '../../common/auth/auth.decorators';
import type { AuthUser } from '../../common/auth/auth.types';
import {
  RecentSearchDto,
  RecentSearchListDto,
  RecordRecentDto,
  SearchQuery,
  SearchResponseDto,
} from './dto';
import { RecentSearchService } from './recent.service';
import { SearchService } from './search.service';

@ApiTags('search')
@Controller('search')
export class SearchController {
  constructor(
    private readonly search: SearchService,
    private readonly recent: RecentSearchService,
  ) {}

  @Public()
  @ApiBearerAuth()
  @Get()
  @ApiOperation({
    summary: 'Search people, clubs, venues, pitches, tournaments and events',
    description:
      'Exact @username first, then nickname prefix, then trigram similarity. Results carry an explicit entityType and stable id. Without `type`: ≤ 4 per type plus the true total. With `type`: keyset-paginated. Blocked, suspended/deleted and hidden entities are excluded; private profiles are findable by identity only.',
  })
  @ApiOkResponse({ type: SearchResponseDto })
  get(@OptionalUser() viewer: AuthUser | null, @Query() q: SearchQuery) {
    return this.search.search(viewer?.userId ?? null, q);
  }

  @ApiBearerAuth()
  @Post('recent')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Remember a search or an opened result',
    description:
      'Upsert (deduplicated, bumps lastUsedAt); at most 20 entries per user, the oldest are dropped. Body: {query} (2-80 chars) or {entityType, entityId}.',
  })
  @ApiOkResponse({ type: RecentSearchDto })
  record(@CurrentUser() user: AuthUser, @Body() dto: RecordRecentDto) {
    return this.recent.record(user.userId, dto);
  }

  @ApiBearerAuth()
  @Get('recent')
  @ApiOperation({
    summary: 'Your recent searches, newest first',
    description:
      'Entity entries are re-resolved with the search visibility rules; inaccessible ones are returned as {unavailable:true} without any details.',
  })
  @ApiOkResponse({ type: RecentSearchListDto })
  listRecent(@CurrentUser() user: AuthUser) {
    return this.recent.list(user.userId);
  }

  @ApiBearerAuth()
  @Delete('recent/:id')
  @HttpCode(204)
  @ApiNoContentResponse({ description: 'Removes one of your entries (404 for anything else)' })
  async removeRecent(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.recent.remove(user.userId, id);
  }

  @ApiBearerAuth()
  @Delete('recent')
  @HttpCode(204)
  @ApiNoContentResponse({ description: 'Deletes your whole search history' })
  async clearRecent(@CurrentUser() user: AuthUser) {
    await this.recent.clear(user.userId);
  }
}
