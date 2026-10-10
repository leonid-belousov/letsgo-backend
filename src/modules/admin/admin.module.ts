import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GamesModule } from '../games/games.module';
import { AccountDeletionService } from './account-deletion.service';
import { AccountController, AdminController } from './admin.controller';
import { AdminService } from './admin.service';

@Module({
  imports: [AuthModule, GamesModule],
  controllers: [AdminController, AccountController],
  providers: [AdminService, AccountDeletionService],
})
export class AdminModule {}
