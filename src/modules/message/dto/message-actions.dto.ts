import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class ReplyMessageDto {
  @ApiProperty({
    description: 'WhatsApp chat ID',
    example: '628123456789@c.us',
  })
  @IsString()
  @IsNotEmpty()
  chatId: string;

  @ApiProperty({
    description: 'Quoted WhatsApp message ID to reply to',
    example: 'true_628123456789@c.us_3EB0123456789',
  })
  @IsString()
  @IsNotEmpty()
  quotedMessageId: string;

  @ApiProperty({
    description: 'Reply text',
    example: 'Jasne, robimy to dzisiaj.',
    maxLength: 4096,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  text: string;
}

export class ReplyByMessageIdDto {
  @ApiProperty({
    description: 'Quoted WhatsApp message ID (or internal message UUID stored in history)',
    example: 'true_628123456789@c.us_3EB0123456789',
  })
  @IsString()
  @IsNotEmpty()
  quotedMessageId: string;

  @ApiProperty({
    description: 'Reply text',
    example: 'Potwierdzam, działamy.',
    maxLength: 4096,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  text: string;

  @ApiPropertyOptional({
    description:
      'Target chat ID. Optional when quoted message exists in session history and chat can be resolved automatically.',
    example: '628123456789@c.us',
  })
  @IsOptional()
  @IsString()
  chatId?: string;
}

export class ForwardMessageDto {
  @ApiProperty({
    description: 'Source chat ID containing the message',
    example: '628123456789@c.us',
  })
  @IsString()
  @IsNotEmpty()
  fromChatId: string;

  @ApiProperty({
    description: 'Destination chat ID',
    example: '628987654321@c.us',
  })
  @IsString()
  @IsNotEmpty()
  toChatId: string;

  @ApiProperty({
    description: 'Message ID to forward',
    example: 'true_628123456789@c.us_3EB0123456789',
  })
  @IsString()
  @IsNotEmpty()
  messageId: string;
}

export class MessageDetailsResponseDto {
  @ApiProperty({ example: '8f6db64c-0a24-4cd6-9f23-5fd7be524f1c' })
  id: string;

  @ApiPropertyOptional({ example: 'true_628123456789@c.us_3EB0123456789' })
  waMessageId?: string;

  @ApiProperty({ example: 'my-session' })
  sessionId: string;

  @ApiProperty({ example: '628123456789@c.us' })
  chatId: string;

  @ApiProperty({ example: '628123456789@c.us' })
  from: string;

  @ApiProperty({ example: '628123456789@c.us' })
  to: string;

  @ApiPropertyOptional({ example: 'Treść wiadomości' })
  body?: string;

  @ApiProperty({ example: 'text' })
  type: string;

  @ApiPropertyOptional({ example: 1706868000 })
  timestamp?: number;

  @ApiProperty({ example: 'sent' })
  status: string;

  @ApiProperty({ example: 'incoming' })
  direction: string;

  @ApiProperty({ example: true })
  hasReply: boolean;

  @ApiPropertyOptional({ example: 'true_628123456789@c.us_3EB0123456780' })
  quotedMessageId: string | null;

  @ApiPropertyOptional({ example: 'Poprzednia wiadomość' })
  quotedMessageBody: string | null;
}
