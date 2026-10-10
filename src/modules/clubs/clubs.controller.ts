import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiCreatedResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentUser, OptionalUser, Public } from '../../common/auth/auth.decorators';
import type { AuthUser } from '../../common/auth/auth.types';
import { IdempotencyKey } from '../../common/idempotency/idempotency-key.decorator';
import { PageQuery } from '../../common/pagination/cursor-page';
import { ClubsService } from './clubs.service';
import {
  ClubAwardDto,
  ClubAwardPageDto,
  ClubDto,
  ClubSearchPageDto,
  ClubSearchQuery,
  ClubUsernameAvailabilityDto,
  CreateClubAwardDto,
  CreateClubDto,
  MyClubsPageDto,
  UpdateClubDto,
  UsernameAvailabilityQuery,
} from './dto';

@ApiTags('clubs')
@Controller('clubs')
export class ClubsController {
  constructor(private readonly clubs: ClubsService) {}

  @ApiBearerAuth()
  @Post()
  @ApiOperation({
    summary:
      'Create a club (creator becomes founder, owner and a member; nobody is enrolled in games)',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiCreatedResponse({ type: ClubDto })
  @ApiConflictResponse({
    description: 'CONFLICT with details.field = username: "This username is taken."',
  })
  create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateClubDto,
    @IdempotencyKey() key: string | undefined,
  ) {
    return this.clubs.create(user.userId, dto, key);
  }

  @Public()
  @Get('username-available')
  @ApiOperation({ summary: 'Club handle availability (viewer-independent, case-insensitive)' })
  @ApiOkResponse({ type: ClubUsernameAvailabilityDto })
  available(@Query() q: UsernameAvailabilityQuery) {
    return this.clubs.isUsernameAvailable(q.username);
  }

  @ApiBearerAuth()
  @Get('mine')
  @ApiOperation({ summary: 'Clubs I am a member of' })
  @ApiOkResponse({ type: MyClubsPageDto })
  mine(@CurrentUser() user: AuthUser, @Query() page: PageQuery) {
    return this.clubs.mine(user.userId, page);
  }

  @Public()
  @ApiBearerAuth()
  @Get()
  @ApiOperation({
    summary: 'Search clubs by name/username and city (entityType CLUB; private clubs by name only)',
  })
  @ApiOkResponse({ type: ClubSearchPageDto })
  search(@OptionalUser() viewer: AuthUser | null, @Query() q: ClubSearchQuery) {
    return this.clubs.search(viewer?.userId ?? null, q);
  }

  @Public()
  @ApiBearerAuth()
  @Get('by-username/:username')
  @ApiOkResponse({ type: ClubDto })
  @ApiNotFoundResponse()
  byUsername(@OptionalUser() viewer: AuthUser | null, @Param('username') username: string) {
    return this.clubs.getByUsername(viewer?.userId ?? null, username);
  }

  @Public()
  @ApiBearerAuth()
  @Get(':id')
  @ApiOperation({
    summary: 'Club page, shaped by the viewer (private clubs: name card for non-members)',
  })
  @ApiOkResponse({ type: ClubDto })
  @ApiNotFoundResponse()
  get(@OptionalUser() viewer: AuthUser | null, @Param('id', ParseUUIDPipe) id: string) {
    return this.clubs.get(viewer?.userId ?? null, id);
  }

  @ApiBearerAuth()
  @Patch(':id')
  @ApiOperation({ summary: 'Edit club profile (club.profile.edit, optimistic `version`)' })
  @ApiOkResponse({ type: ClubDto })
  @ApiForbiddenResponse()
  @ApiConflictResponse({ description: 'VERSION_CHANGED' })
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateClubDto,
  ) {
    return this.clubs.update(user.userId, id, dto);
  }

  @ApiBearerAuth()
  @Post(':id/archive')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Archive the club (owner only). Archived clubs reject joins and new events.',
  })
  @ApiOkResponse({ type: ClubDto })
  archive(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ) {
    return this.clubs.archive(user.userId, id, String(req.id));
  }

  @ApiBearerAuth()
  @Post(':id/awards')
  @ApiOperation({
    summary: 'Give a club award to a member (club.awards.manage). Not an official stat.',
  })
  @ApiCreatedResponse({ type: ClubAwardDto })
  createAward(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateClubAwardDto,
    @Req() req: Request,
  ): Promise<ClubAwardDto> {
    return this.clubs.createAward(user.userId, id, dto, String(req.id));
  }

  @Public()
  @ApiBearerAuth()
  @Get(':id/awards')
  @ApiOkResponse({ type: ClubAwardPageDto })
  awards(
    @OptionalUser() viewer: AuthUser | null,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() page: PageQuery,
  ) {
    return this.clubs.listAwards(viewer?.userId ?? null, id, page);
  }
}
