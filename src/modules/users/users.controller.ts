import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';
import { CurrentUser, OptionalUser, Public } from '../../common/auth/auth.decorators';
import type { AuthUser } from '../../common/auth/auth.types';
import {
  OwnerProfileDto,
  PublicProfileDto,
  UpdateProfileDto,
  UsernameAvailabilityDto,
} from './dto';
import { UsersService } from './users.service';

class UsernameQuery {
  @ApiProperty({ maxLength: 40 }) @IsString() @MaxLength(40) username!: string;
}

@ApiTags('users')
@Controller()
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @ApiBearerAuth()
  @Get('me')
  @ApiOkResponse({ type: OwnerProfileDto, description: 'Owner view: includes DOB and contacts' })
  me(@CurrentUser() user: AuthUser) {
    return this.users.getOwn(user.userId);
  }

  @ApiBearerAuth()
  @Patch('me/profile')
  @ApiOkResponse({ type: OwnerProfileDto })
  update(@CurrentUser() user: AuthUser, @Body() dto: UpdateProfileDto) {
    return this.users.updateOwn(user.userId, dto);
  }

  @Public()
  @Get('users/username-available')
  @ApiOkResponse({ type: UsernameAvailabilityDto })
  async available(@Query() q: UsernameQuery): Promise<UsernameAvailabilityDto> {
    return {
      username: q.username.trim().toLowerCase(),
      available: await this.users.isUsernameAvailable(q.username),
    };
  }

  @Public()
  @ApiBearerAuth()
  @Get('users/by-username/:username')
  @ApiOkResponse({
    type: PublicProfileDto,
    description: 'Viewer-aware; visitors allowed. Private fields are omitted, not hidden.',
  })
  byUsername(@OptionalUser() viewer: AuthUser | null, @Param('username') username: string) {
    return this.users.getPublicByUsername(viewer?.userId ?? null, username);
  }

  @Public()
  @ApiBearerAuth()
  @Get('users/:id')
  @ApiOkResponse({ type: PublicProfileDto })
  byId(@OptionalUser() viewer: AuthUser | null, @Param('id', ParseUUIDPipe) id: string) {
    return this.users.getPublic(viewer?.userId ?? null, id);
  }
}
