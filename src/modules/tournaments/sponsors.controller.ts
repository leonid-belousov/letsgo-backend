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
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentUser, OptionalUser, Public } from '../../common/auth/auth.decorators';
import type { AuthUser } from '../../common/auth/auth.types';
import { IdempotencyKey } from '../../common/idempotency/idempotency-key.decorator';
import {
  AddSponsorAssetDto,
  CreateSponsorDto,
  ReorderDto,
  SetMainSponsorDto,
  SponsorDto,
  SponsorListDto,
  UpdateSponsorAssetDto,
  UpdateSponsorDto,
} from './dto/sponsors.dto';
import { SponsorsService } from './sponsors.service';

const idem = { name: 'Idempotency-Key', required: false, description: 'Safe retries' };

@ApiTags('tournaments')
@ApiBearerAuth()
@Controller('tournaments/:id/sponsors')
export class SponsorsController {
  constructor(private readonly sponsors: SponsorsService) {}

  @Public()
  @Get()
  @ApiOkResponse({ type: SponsorListDto })
  list(@OptionalUser() viewer: AuthUser | null, @Param('id', ParseUUIDPipe) id: string) {
    return this.sponsors.list(viewer?.userId ?? null, id);
  }

  @Post()
  @ApiHeader(idem)
  @ApiCreatedResponse({
    type: SponsorDto,
    description: 'Allowed at any tournament stage (organiser or tournament.sponsors)',
  })
  create(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateSponsorDto,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
  ) {
    return this.sponsors.create(u.userId, id, dto, key, String(req.id));
  }

  @Put('order')
  @ApiHeader(idem)
  @ApiOkResponse({ type: SponsorListDto })
  reorder(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReorderDto,
    @IdempotencyKey() key: string | undefined,
  ) {
    return this.sponsors.reorder(u.userId, id, dto, key);
  }

  @Put('main')
  @ApiHeader(idem)
  @ApiOkResponse({
    type: SponsorListDto,
    description: 'Exactly one Main sponsor (of this tournament) shows on the card; null clears',
  })
  setMain(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetMainSponsorDto,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
  ) {
    return this.sponsors.setMain(u.userId, id, dto, key, String(req.id));
  }

  @Patch(':sponsorId')
  @ApiHeader(idem)
  @ApiOkResponse({ type: SponsorDto })
  update(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sponsorId', ParseUUIDPipe) sponsorId: string,
    @Body() dto: UpdateSponsorDto,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
  ) {
    return this.sponsors.update(u.userId, id, sponsorId, dto, key, String(req.id));
  }

  @Post(':sponsorId/assets')
  @HttpCode(200)
  @ApiHeader(idem)
  @ApiOkResponse({ type: SponsorDto })
  addAsset(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sponsorId', ParseUUIDPipe) sponsorId: string,
    @Body() dto: AddSponsorAssetDto,
    @IdempotencyKey() key: string | undefined,
  ) {
    return this.sponsors.addAsset(u.userId, id, sponsorId, dto, key);
  }

  @Put(':sponsorId/assets/order')
  @ApiHeader(idem)
  @ApiOkResponse({ type: SponsorDto })
  reorderAssets(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sponsorId', ParseUUIDPipe) sponsorId: string,
    @Body() dto: ReorderDto,
    @IdempotencyKey() key: string | undefined,
  ) {
    return this.sponsors.reorderAssets(u.userId, id, sponsorId, dto, key);
  }

  @Patch(':sponsorId/assets/:assetId')
  @ApiHeader(idem)
  @ApiOkResponse({ type: SponsorDto })
  updateAsset(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sponsorId', ParseUUIDPipe) sponsorId: string,
    @Param('assetId', ParseUUIDPipe) assetId: string,
    @Body() dto: UpdateSponsorAssetDto,
    @IdempotencyKey() key: string | undefined,
  ) {
    return this.sponsors.updateAsset(u.userId, id, sponsorId, assetId, dto, key);
  }

  @Delete(':sponsorId/assets/:assetId')
  @ApiHeader(idem)
  @ApiOkResponse({ type: SponsorDto })
  deleteAsset(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sponsorId', ParseUUIDPipe) sponsorId: string,
    @Param('assetId', ParseUUIDPipe) assetId: string,
    @IdempotencyKey() key: string | undefined,
  ) {
    return this.sponsors.deleteAsset(u.userId, id, sponsorId, assetId, key);
  }
}
