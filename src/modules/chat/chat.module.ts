import { Module } from '@nestjs/common';
import { ChatAccessService } from './chat-access.service';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';

@Module({
  controllers: [ChatController],
  providers: [ChatService, ChatAccessService],
  exports: [ChatService, ChatAccessService],
})
export class ChatModule {}
