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
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { GrantResourceType } from '@prisma/client';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import type { Request } from 'express';
import { CurrentUser } from '../../common/auth/auth.decorators';
import type { AuthUser } from '../../common/auth/auth.types';
import { AccessService } from './access.service';
import { CreateGrantDto, GrantDto, PermissionCatalogItemDto, RevokeGrantDto } from './dto';

class ListGrantsQuery {
  @ApiProperty({ enum: GrantResourceType })
  @IsEnum(GrantResourceType)
  resourceType!: GrantResourceType;
  @ApiPropertyOptional() @IsOptional() @IsUUID() resourceId?: string;
}

class PermissionCatalogQuery {
  @ApiPropertyOptional({
    enum: GrantResourceType,
    description: 'Optional scope filter; omit to return all resource scopes',
  })
  @IsOptional()
  @IsEnum(GrantResourceType)
  resourceType?: GrantResourceType;
}

@ApiTags('access')
@ApiBearerAuth()
@Controller('grants')
export class AccessController {
  constructor(private readonly access: AccessService) {}

  @Get('catalog')
  @ApiOperation({
    summary: 'List the server permission catalogue',
    description: 'Describes grantable actions. It never grants access by itself.',
  })
  @ApiOkResponse({ type: [PermissionCatalogItemDto] })
  catalog(@Query() q: PermissionCatalogQuery) {
    return this.access.catalog(q.resourceType);
  }

  @Post()
  @ApiOkResponse({
    type: GrantDto,
    description: 'Root grant (structural authority) or delegated grant',
  })
  async create(@CurrentUser() user: AuthUser, @Body() dto: CreateGrantDto, @Req() req: Request) {
    const g = await this.access.create(
      user.userId,
      { ...dto, resourceId: dto.resourceId ?? null },
      String(req.id),
    );
    return GrantDto.from(g);
  }

  @Delete(':id')
  @HttpCode(200)
  @ApiOkResponse({ description: 'Grant and all grants delegated from it are revoked' })
  revoke(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RevokeGrantDto,
    @Req() req: Request,
  ) {
    return this.access.revoke(user.userId, id, dto.reason, String(req.id));
  }

  @Get()
  @ApiOkResponse({ type: [GrantDto] })
  async list(@CurrentUser() user: AuthUser, @Query() q: ListGrantsQuery) {
    const rows = await this.access.listForResource(
      user.userId,
      q.resourceType,
      q.resourceId ?? null,
    );
    return rows.map((g) => GrantDto.from(g));
  }

  @Get('mine')
  @ApiOkResponse({ type: [GrantDto] })
  async mine(@CurrentUser() user: AuthUser) {
    return (await this.access.listMine(user.userId)).map((g) => GrantDto.from(g));
  }
}
