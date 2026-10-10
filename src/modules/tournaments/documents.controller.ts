import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
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
  ConsentDto,
  ConsentMatrixDto,
  ConsentRequestDto,
  CreateDocumentDto,
  DocumentDto,
  NewDocumentVersionDto,
  RemindDto,
  RemindResultDto,
  RequiredDocumentDto,
  UpdateDocumentDto,
} from './dto/documents.dto';
import { DocumentsService } from './documents.service';

const idem = { name: 'Idempotency-Key', required: false, description: 'Safe retries' };

@ApiTags('tournaments')
@ApiBearerAuth()
@Controller('tournaments/:id')
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Public()
  @Get('documents')
  @ApiOkResponse({
    type: [DocumentDto],
    description: 'Rules and files with their append-only version history',
  })
  list(@OptionalUser() viewer: AuthUser | null, @Param('id', ParseUUIDPipe) id: string) {
    return this.documents.list(viewer?.userId ?? null, id);
  }

  @Post('documents')
  @ApiHeader(idem)
  @ApiCreatedResponse({ type: DocumentDto })
  create(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateDocumentDto,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
  ) {
    return this.documents.create(u.userId, id, dto, key, String(req.id));
  }

  @Patch('documents/:documentId')
  @ApiHeader(idem)
  @ApiOkResponse({ type: DocumentDto })
  update(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @Body() dto: UpdateDocumentDto,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
  ) {
    return this.documents.update(u.userId, id, documentId, dto, key, String(req.id));
  }

  @Post('documents/:documentId/versions')
  @ApiHeader(idem)
  @ApiCreatedResponse({
    type: DocumentDto,
    description:
      'New content = new version: audience must accept again; old acceptances stay in history',
  })
  addVersion(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @Body() dto: NewDocumentVersionDto,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
  ) {
    return this.documents.addVersion(u.userId, id, documentId, dto, key, String(req.id));
  }

  @Get('documents-required')
  @ApiOkResponse({
    type: [RequiredDocumentDto],
    description: 'Only the documents assigned to MY role(s) in this tournament',
  })
  required(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.documents.required(u.userId, id);
  }

  @Post('documents/:documentId/consent')
  @HttpCode(200)
  @ApiHeader(idem)
  @ApiOkResponse({
    type: ConsentDto,
    description:
      'Personal acceptance. A representative can never accept for players; opening a file is not consent.',
  })
  consent(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @Body() dto: ConsentRequestDto,
    @IdempotencyKey() key: string | undefined,
  ) {
    return this.documents.consent(u.userId, id, documentId, dto, key);
  }

  @Get('consents/matrix')
  @ApiOkResponse({
    type: ConsentMatrixDto,
    description: 'Who is missing what (tournament.applications)',
  })
  matrix(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.documents.matrix(u.userId, id);
  }

  @Post('consents/remind')
  @HttpCode(200)
  @ApiHeader(idem)
  @ApiOkResponse({
    type: RemindResultDto,
    description:
      'Explicit reminder to people who miss mandatory acceptances (a notice is not a consent)',
  })
  remind(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RemindDto,
    @IdempotencyKey() key: string | undefined,
  ) {
    return this.documents.remind(u.userId, id, dto, key);
  }
}
