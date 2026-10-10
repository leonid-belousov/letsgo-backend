import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentUser } from '../../common/auth/auth.decorators';
import type { AuthUser } from '../../common/auth/auth.types';
import { IdempotencyKey } from '../../common/idempotency/idempotency-key.decorator';
import { PageQuery } from '../../common/pagination/cursor-page';
import {
  AdminVenueRequestDto,
  AdminVenueRequestPageDto,
  AdminVenueRequestQuery,
  ApproveVenueRequestDto,
  CreateVenueRequestDto,
  MyVenueRequestDto,
  MyVenueRequestPageDto,
  RespondVenueRequestDto,
  VenueRequestMessageDto,
} from './dto';
import { VenueRequestsService } from './venue-requests.service';

@ApiTags('venues')
@ApiBearerAuth()
@Controller('venue-requests')
export class VenueRequestsController {
  constructor(private readonly requests: VenueRequestsService) {}

  @Post()
  @ApiOperation({
    summary: 'Ask Let’sGo to add a paid pitch (name, city, point/address, ≥ 1 photo)',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiCreatedResponse({ type: MyVenueRequestDto })
  create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateVenueRequestDto,
    @IdempotencyKey() key: string | undefined,
  ) {
    return this.requests.createRequest(user.userId, dto, key);
  }

  @Get('mine')
  @ApiOperation({ summary: 'My requests; answers are shown as coming from “Let’sGo”' })
  @ApiOkResponse({ type: MyVenueRequestPageDto })
  mine(@CurrentUser() user: AuthUser, @Query() page: PageQuery) {
    return this.requests.listMine(user.userId, page);
  }

  @Get(':id')
  @ApiOkResponse({ type: MyVenueRequestDto })
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.requests.getMine(user.userId, id);
  }

  @Post(':id/respond')
  @HttpCode(200)
  @ApiOperation({ summary: 'Answer a “more information needed” message' })
  @ApiOkResponse({ type: MyVenueRequestDto })
  respond(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RespondVenueRequestDto,
  ) {
    return this.requests.respond(user.userId, id, dto);
  }
}

@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/venue-requests')
export class AdminVenueRequestsController {
  constructor(private readonly requests: VenueRequestsService) {}

  @Get()
  @ApiOperation({ summary: 'Review queue (admin.venueRequests.review)' })
  @ApiOkResponse({ type: AdminVenueRequestPageDto })
  list(@CurrentUser() user: AuthUser, @Query() q: AdminVenueRequestQuery) {
    return this.requests.adminList(user.userId, q);
  }

  @Get(':id')
  @ApiOkResponse({ type: AdminVenueRequestDto })
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.requests.adminGet(user.userId, id);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Approve: creates the paid venue + pitch as DRAFT (publishing is a separate staff action)',
  })
  @ApiOkResponse({ type: AdminVenueRequestDto })
  approve(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApproveVenueRequestDto,
    @Req() req: Request,
  ) {
    return this.requests.approve(user.userId, id, dto, String(req.id));
  }

  @Post(':id/request-info')
  @HttpCode(200)
  @ApiOkResponse({ type: AdminVenueRequestDto })
  requestInfo(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VenueRequestMessageDto,
    @Req() req: Request,
  ) {
    return this.requests.requestMoreInfo(user.userId, id, dto, String(req.id));
  }

  @Post(':id/decline')
  @HttpCode(200)
  @ApiOkResponse({ type: AdminVenueRequestDto })
  decline(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VenueRequestMessageDto,
    @Req() req: Request,
  ) {
    return this.requests.decline(user.userId, id, dto, String(req.id));
  }
}
