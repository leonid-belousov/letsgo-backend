import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseEnumPipe,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { RatingSubject } from '@prisma/client';
import type { Request } from 'express';
import { CurrentUser, OptionalUser, Public } from '../../common/auth/auth.decorators';
import type { AuthUser } from '../../common/auth/auth.types';
import {
  AdminRatingDto,
  EventRatingsDto,
  HideRatingDto,
  RatingDto,
  RatingsGivenPageDto,
  RatingsPageQuery,
  RatingsReceivedPageDto,
  SubjectRatingDto,
  UpsertRatingDto,
} from './dto';
import { RatingsService } from './ratings.service';

@ApiTags('ratings')
@ApiBearerAuth()
@Controller()
export class RatingsController {
  constructor(private readonly ratings: RatingsService) {}

  @Put('ratings')
  @ApiOkResponse({
    type: RatingDto,
    description:
      'Create or edit (one rating per author/subject/game). Confirmed players of a finished game only; no self-rating; editable until editableUntil.',
  })
  upsert(@CurrentUser() user: AuthUser, @Body() dto: UpsertRatingDto) {
    return this.ratings.upsert(user.userId, dto);
  }

  @Public()
  @Get('ratings/subject/:type/:id')
  @ApiOkResponse({
    type: SubjectRatingDto,
    description:
      'Public aggregate: mean of visible ratings (1 decimal) and count. No ratings ⇒ average null.',
  })
  aggregate(
    @OptionalUser() viewer: AuthUser | null,
    @Param('type', new ParseEnumPipe(RatingSubject)) type: RatingSubject,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.ratings.subjectAggregate(viewer?.userId ?? null, type, id);
  }

  @Get('ratings/events/:eventId/mine')
  @ApiOkResponse({
    type: EventRatingsDto,
    description: 'Who I may rate for this game and what I already rated',
  })
  forEvent(@CurrentUser() user: AuthUser, @Param('eventId', ParseUUIDPipe) eventId: string) {
    return this.ratings.forEvent(user.userId, eventId);
  }

  @Get('me/ratings/given')
  @ApiOkResponse({ type: RatingsGivenPageDto })
  given(@CurrentUser() user: AuthUser, @Query() q: RatingsPageQuery) {
    return this.ratings.given(user.userId, q);
  }

  @Get('me/ratings/received')
  @ApiOkResponse({ type: RatingsReceivedPageDto, description: 'Authors are never revealed' })
  received(@CurrentUser() user: AuthUser, @Query() q: RatingsPageQuery) {
    return this.ratings.received(user.userId, q);
  }

  @Post('admin/ratings/:id/hide')
  @HttpCode(200)
  @ApiOkResponse({
    type: AdminRatingDto,
    description: 'Moderator hides a rating from all aggregates (reason + audit)',
  })
  hide(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: HideRatingDto,
    @Req() req: Request,
  ) {
    return this.ratings.setHidden(user.userId, id, true, dto.reason, String(req.id));
  }

  @Post('admin/ratings/:id/unhide')
  @HttpCode(200)
  @ApiOkResponse({ type: AdminRatingDto })
  unhide(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: HideRatingDto,
    @Req() req: Request,
  ) {
    return this.ratings.setHidden(user.userId, id, false, dto.reason, String(req.id));
  }
}
