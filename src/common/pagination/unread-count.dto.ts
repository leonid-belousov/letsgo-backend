import { ApiProperty } from '@nestjs/swagger';

/** Body of the three `GET …/unread-count` endpoints (activity, chat, notifications). */
export class UnreadCountDto {
  @ApiProperty({ minimum: 0 }) unread!: number;
}
