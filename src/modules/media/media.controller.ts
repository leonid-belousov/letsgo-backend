import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { CurrentUser, OptionalUser, Public } from '../../common/auth/auth.decorators';
import type { AuthUser } from '../../common/auth/auth.types';
import { IdempotencyKey } from '../../common/idempotency/idempotency-key.decorator';
import { PageQuery } from '../../common/pagination/cursor-page';
import {
  ContentQuery,
  CreateUploadDto,
  FinalizeUploadDto,
  MediaAssetDto,
  MediaPageDto,
  SignedUrlDto,
  UrlQuery,
} from './dto';
import { MediaService } from './media.service';

@ApiTags('media')
@Controller('media')
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @ApiBearerAuth()
  @Post('uploads')
  @ApiOperation({
    summary: 'Create an upload intent',
    description:
      'Validates kind / mime allow-list / declared size / video duration up front (UPLOAD_FAILED with the concrete limit in details). Then PUT the bytes to `upload.path` and finalize. Retrying a failed upload = a new intent.',
  })
  @ApiCreatedResponse({ type: MediaAssetDto })
  createIntent(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateUploadDto,
    @IdempotencyKey() key: string | undefined,
  ) {
    return this.media.createIntent(user.userId, dto, key);
  }

  @ApiBearerAuth()
  @Put(':id/content')
  @ApiOperation({
    summary: 'Upload the bytes (raw body)',
    description:
      'DEV/TECH local-disk storage; the production provider is an OPEN decision. Actual size may not exceed the declared size and the content must match the declared mime type, otherwise the asset becomes FAILED.',
  })
  @ApiConsumes('application/octet-stream')
  @ApiBody({ schema: { type: 'string', format: 'binary' } })
  @ApiOkResponse({ type: MediaAssetDto })
  upload(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ) {
    const len = req.headers['content-length'];
    const parsed = len !== undefined ? Number(len) : undefined;
    return this.media.upload(
      user.userId,
      id,
      req,
      req.headers['content-type'],
      parsed !== undefined && Number.isFinite(parsed) ? parsed : undefined,
    );
  }

  @ApiBearerAuth()
  @Post(':id/finalize')
  @HttpCode(200)
  @ApiOkResponse({ type: MediaAssetDto, description: 'PROCESSING → READY (idempotent)' })
  finalize(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: FinalizeUploadDto,
  ) {
    return this.media.finalize(user.userId, id, dto.checksum);
  }

  @ApiBearerAuth()
  @Get()
  @ApiOkResponse({ type: MediaPageDto, description: 'Your own uploads' })
  list(@CurrentUser() user: AuthUser, @Query() q: PageQuery) {
    return this.media.listOwn(user.userId, q);
  }

  @ApiBearerAuth()
  @Get(':id')
  @ApiOkResponse({
    type: MediaAssetDto,
    description: 'Owner metadata (no EXIF / geo data is ever exposed)',
  })
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.media.getOwn(user.userId, id);
  }

  @ApiBearerAuth()
  @Delete(':id')
  @HttpCode(204)
  @ApiNoContentResponse({
    description: 'Soft delete; refused (409) while the media is attached to content',
  })
  async remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.media.remove(user.userId, id);
  }

  @Public()
  @ApiBearerAuth()
  @Get(':id/url')
  @ApiOperation({
    summary: 'Short-lived signed URL',
    description:
      'Access is re-checked on EVERY call (owner, public media, or attached to content the viewer may view). The URL is valid for at most 5 minutes.',
  })
  @ApiOkResponse({ type: SignedUrlDto })
  url(
    @OptionalUser() viewer: AuthUser | null,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: UrlQuery,
  ) {
    return this.media.signedUrl(viewer?.userId ?? null, id, q.variant ?? 'original');
  }

  @Public()
  @Get(':id/content')
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  @ApiOperation({ summary: 'Serve bytes for a valid signed token (expired → 410)' })
  @ApiOkResponse({ description: 'Binary content' })
  async content(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: ContentQuery,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const obj = await this.media.openContent(id, q.token);
    res.setHeader('Content-Type', obj.mimeType);
    return new StreamableFile(obj.stream, {
      type: obj.mimeType,
      length: obj.sizeBytes,
      disposition: obj.kind === 'DOCUMENT' ? 'attachment' : 'inline',
    });
  }
}
