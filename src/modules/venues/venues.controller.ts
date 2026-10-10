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
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { CurrentUser, OptionalUser, Public } from '../../common/auth/auth.decorators';
import type { AuthUser } from '../../common/auth/auth.types';
import { IdempotencyKey } from '../../common/idempotency/idempotency-key.decorator';
import { PageQuery } from '../../common/pagination/cursor-page';
import { PitchStructureService } from './pitch-structure.service';
import { VenueRequestsService } from './venue-requests.service';
import {
  BookingTermsDto,
  CommunityPitchDto,
  CommunityPitchResultDto,
  ConfigurationInputDto,
  CreatePitchDto,
  CreateTermsDto,
  CreateVenueDto,
  PartNameDto,
  PitchDto,
  PutBookingRulesDto,
  TermsListDto,
  UpdateConfigurationDto,
  UpdatePitchDto,
  UpdateVenueDto,
  VenueDetailDto,
  VenueListQuery,
  VenuePageDto,
} from './dto';
import { VenuesService } from './venues.service';

@ApiTags('venues')
@Controller('venues')
export class VenuesController {
  constructor(
    private readonly venues: VenuesService,
    private readonly requests: VenueRequestsService,
  ) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Search the venue catalog (published venues only; visitors allowed)' })
  @ApiOkResponse({ type: VenuePageDto })
  list(@Query() q: VenueListQuery) {
    return this.venues.list(q);
  }

  @ApiBearerAuth()
  @Get('managed')
  @ApiOperation({ summary: 'Venues I manage or staff, drafts included' })
  @ApiOkResponse({ type: VenuePageDto })
  managed(@CurrentUser() user: AuthUser, @Query() page: PageQuery) {
    return this.venues.managed(user.userId, page);
  }

  @ApiBearerAuth()
  @Post()
  @ApiOperation({ summary: 'Create a paid venue as a DRAFT (admin.catalog.manage)' })
  @ApiCreatedResponse({ type: VenueDetailDto })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateVenueDto, @Req() req: Request) {
    return this.venues.createVenue(user.userId, dto, String(req.id));
  }

  @ApiBearerAuth()
  @Post('community')
  @ApiOperation({
    summary:
      'Add a free community pitch (any person with a complete profile). 201 created, 200 with `duplicateOf` when it already exists.',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiCreatedResponse({ type: CommunityPitchResultDto })
  async community(
    @CurrentUser() user: AuthUser,
    @Body() dto: CommunityPitchDto,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CommunityPitchResultDto> {
    const result = await this.requests.submitCommunity(user.userId, dto, key, String(req.id));
    res.status(result.created ? 201 : 200);
    return result;
  }

  @Public()
  @ApiBearerAuth()
  @Get(':id')
  @ApiOperation({ summary: 'Venue with its pitches (drafts only for managers)' })
  @ApiOkResponse({ type: VenueDetailDto })
  @ApiNotFoundResponse()
  detail(@OptionalUser() viewer: AuthUser | null, @Param('id', ParseUUIDPipe) id: string) {
    return this.venues.venueDetail(viewer?.userId ?? null, id);
  }

  @ApiBearerAuth()
  @Patch(':id')
  @ApiOperation({ summary: 'Edit venue (venue/pitch manager or catalog staff; `version`)' })
  @ApiOkResponse({ type: VenueDetailDto })
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateVenueDto,
    @Req() req: Request,
  ) {
    return this.venues.updateVenue(user.userId, id, dto, String(req.id));
  }

  @ApiBearerAuth()
  @Post(':id/publish')
  @HttpCode(200)
  @ApiOkResponse({ type: VenueDetailDto })
  publish(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ) {
    return this.venues.setVenueStatus(user.userId, id, 'PUBLISHED', String(req.id));
  }

  @ApiBearerAuth()
  @Post(':id/hide')
  @HttpCode(200)
  @ApiOkResponse({ type: VenueDetailDto })
  hide(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.venues.setVenueStatus(user.userId, id, 'HIDDEN', String(req.id));
  }

  @ApiBearerAuth()
  @Post(':id/pitches')
  @ApiOperation({
    summary:
      'Add a pitch (DRAFT) with its parts, a default “Whole pitch” configuration and default booking rules',
  })
  @ApiCreatedResponse({ type: PitchDto })
  createPitch(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreatePitchDto,
    @Req() req: Request,
  ) {
    return this.venues.createPitch(user.userId, id, dto, String(req.id));
  }
}

@ApiTags('venues')
@Controller('pitches')
export class PitchesController {
  constructor(
    private readonly venues: VenuesService,
    private readonly structure: PitchStructureService,
  ) {}

  @Public()
  @ApiBearerAuth()
  @Get(':id')
  @ApiOperation({ summary: 'Pitch detail: surface, setting, size, formats, price, rules, terms' })
  @ApiOkResponse({ type: PitchDto })
  @ApiNotFoundResponse()
  detail(@OptionalUser() viewer: AuthUser | null, @Param('id', ParseUUIDPipe) id: string) {
    return this.venues.pitchDetail(viewer?.userId ?? null, id);
  }

  @ApiBearerAuth()
  @Patch(':id')
  @ApiOkResponse({ type: PitchDto })
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePitchDto,
    @Req() req: Request,
  ) {
    return this.venues.updatePitch(user.userId, id, dto, String(req.id));
  }

  @ApiBearerAuth()
  @Post(':id/publish')
  @HttpCode(200)
  @ApiOkResponse({ type: PitchDto })
  publish(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ) {
    return this.venues.setPitchStatus(user.userId, id, 'PUBLISHED', String(req.id));
  }

  @ApiBearerAuth()
  @Post(':id/hide')
  @HttpCode(200)
  @ApiOkResponse({ type: PitchDto })
  hide(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.venues.setPitchStatus(user.userId, id, 'HIDDEN', String(req.id));
  }

  // ── parts & configurations ──

  @ApiBearerAuth()
  @Post(':id/parts')
  @ApiOperation({ summary: 'Add an atomic part (also joins the “Whole pitch” configuration)' })
  @ApiCreatedResponse({ type: PitchDto })
  addPart(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PartNameDto,
    @Req() req: Request,
  ) {
    return this.structure.addPart(user.userId, id, dto.name, String(req.id));
  }

  @ApiBearerAuth()
  @Patch(':id/parts/:partId')
  @ApiOkResponse({ type: PitchDto })
  renamePart(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('partId', ParseUUIDPipe) partId: string,
    @Body() dto: PartNameDto,
    @Req() req: Request,
  ) {
    return this.structure.renamePart(user.userId, id, partId, dto.name, String(req.id));
  }

  @ApiBearerAuth()
  @Delete(':id/parts/:partId')
  @HttpCode(200)
  @ApiOperation({ summary: 'Remove a part that never had bookings; a pitch keeps ≥ 1 part' })
  @ApiOkResponse({ type: PitchDto })
  removePart(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('partId', ParseUUIDPipe) partId: string,
    @Req() req: Request,
  ) {
    return this.structure.removePart(user.userId, id, partId, String(req.id));
  }

  @ApiBearerAuth()
  @Post(':id/configurations')
  @ApiOperation({ summary: 'Define a bookable combination of parts (e.g. “Half A”)' })
  @ApiCreatedResponse({ type: PitchDto })
  createConfiguration(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConfigurationInputDto,
    @Req() req: Request,
  ) {
    return this.structure.createConfiguration(user.userId, id, dto, String(req.id));
  }

  @ApiBearerAuth()
  @Patch(':id/configurations/:configurationId')
  @ApiOkResponse({ type: PitchDto })
  updateConfiguration(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('configurationId', ParseUUIDPipe) configurationId: string,
    @Body() dto: UpdateConfigurationDto,
    @Req() req: Request,
  ) {
    return this.structure.updateConfiguration(
      user.userId,
      id,
      configurationId,
      dto,
      String(req.id),
    );
  }

  @ApiBearerAuth()
  @Delete(':id/configurations/:configurationId')
  @HttpCode(200)
  @ApiOkResponse({ type: PitchDto })
  deleteConfiguration(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('configurationId', ParseUUIDPipe) configurationId: string,
    @Req() req: Request,
  ) {
    return this.structure.deleteConfiguration(user.userId, id, configurationId, String(req.id));
  }

  // ── rules & terms ──

  @ApiBearerAuth()
  @Put(':id/booking-rules')
  @ApiOperation({
    summary:
      'Change booking rules (min duration, grid, 30-min extension, opening hours). Bumps ruleVersion; existing bookings are untouched.',
  })
  @ApiOkResponse({ type: PitchDto })
  putRules(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PutBookingRulesDto,
    @Req() req: Request,
  ) {
    return this.structure.putRules(user.userId, id, dto, String(req.id));
  }

  @ApiBearerAuth()
  @Post(':id/terms')
  @ApiOperation({ summary: 'Publish a new version of the booking terms (append-only)' })
  @ApiCreatedResponse({ type: BookingTermsDto })
  createTerms(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateTermsDto,
    @Req() req: Request,
  ) {
    return this.structure.createTerms(user.userId, id, dto, String(req.id));
  }

  @ApiBearerAuth()
  @Get(':id/terms')
  @ApiOperation({ summary: 'All terms versions (managers)' })
  @ApiOkResponse({ type: TermsListDto })
  listTerms(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.structure.listTerms(user.userId, id);
  }

  @Public()
  @ApiBearerAuth()
  @Get(':id/terms/latest')
  @ApiOkResponse({ type: BookingTermsDto })
  latestTerms(@OptionalUser() viewer: AuthUser | null, @Param('id', ParseUUIDPipe) id: string) {
    return this.structure.latestTerms(viewer?.userId ?? null, id);
  }
}
