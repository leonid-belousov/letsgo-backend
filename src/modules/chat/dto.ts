import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ConversationKind, MessageKind } from '@prisma/client';
import { IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { PersonSummaryDto } from '../users/person-summary';

export class SendMessageDto {
  @ApiProperty({ minLength: 1, maxLength: 2000 })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  body!: string;
}

export class OpenDirectDto {
  @ApiProperty({ description: 'The person to talk to; requires their message policy to allow you' })
  @IsUUID()
  userId!: string;
}

export class MessageDto {
  @ApiProperty() id!: string;
  @ApiProperty() conversationId!: string;
  @ApiProperty({ nullable: true, type: PersonSummaryDto, description: 'null for system cards' })
  sender!: PersonSummaryDto | null;
  @ApiProperty({ enum: MessageKind }) kind!: MessageKind;
  @ApiProperty({ nullable: true, type: String, description: 'null once deleted' }) body!:
    string | null;
  @ApiPropertyOptional({ nullable: true, type: String, description: 'INVITATION | CASH_REQUEST …' })
  cardType?: string | null;
  @ApiPropertyOptional({
    nullable: true,
    type: 'object',
    additionalProperties: true,
    description: 'Ids and display data only — act via the API, which re-checks access',
  })
  cardPayload?: Record<string, unknown> | null;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) editedAt!: string | null;
  @ApiProperty() deleted!: boolean;
}

export class ConversationCapabilitiesDto {
  @ApiProperty() canRead!: boolean;
  @ApiProperty() canPost!: boolean;
}

export class ConversationDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: ConversationKind }) kind!: ConversationKind;
  @ApiProperty({ nullable: true, type: String }) eventId!: string | null;
  @ApiProperty({ nullable: true, type: String }) clubId!: string | null;
  @ApiProperty({ nullable: true, type: String }) tournamentId!: string | null;
  @ApiProperty({ nullable: true, type: PersonSummaryDto, description: 'DIRECT: the other person' })
  counterpart!: PersonSummaryDto | null;
  @ApiProperty({ nullable: true, type: MessageDto }) lastMessage!: MessageDto | null;
  @ApiProperty({ description: 'Unread messages (the red badge); 0 ⇒ no badge' })
  unreadCount!: number;
  @ApiProperty({ type: ConversationCapabilitiesDto }) capabilities!: ConversationCapabilitiesDto;
}

export class ConversationPageDto {
  @ApiProperty({ type: [ConversationDto] }) items!: ConversationDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
}

export class MessagePageDto {
  @ApiProperty({ type: [MessageDto] }) items!: MessageDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
}
