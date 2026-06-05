import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SessionService } from '../session/session.service';
import { SendTextMessageDto, SendMediaMessageDto, MessageResponseDto } from './dto';
import { MediaInput } from '../../engine/interfaces/whatsapp-engine.interface';
import { Message, MessageDirection, MessageStatus } from './entities/message.entity';
import { HookManager } from '../../core/hooks';

export interface GetMessagesOptions {
  chatId?: string;
  limit?: number;
  offset?: number;
}

@Injectable()
export class MessageService {
  constructor(
    @InjectRepository(Message, 'data')
    private readonly messageRepository: Repository<Message>,
    private readonly sessionService: SessionService,
    private readonly hookManager: HookManager,
  ) {}

  async sendText(sessionId: string, dto: SendTextMessageDto): Promise<MessageResponseDto> {
    // Execute hook before sending - plugins can modify or block
    const { continue: shouldContinue, data: hookData } = await this.hookManager.execute(
      'message:sending',
      { sessionId, input: dto, type: 'text' },
      { sessionId, source: 'MessageService' },
    );

    if (!shouldContinue) {
      throw new BadRequestException('Message sending blocked by plugin');
    }

    // Use potentially modified input
    const finalDto = (hookData as { input: SendTextMessageDto }).input;

    const engine = this.getEngine(sessionId);

    // Save message as pending BEFORE sending
    const message = await this.saveOutgoingMessage(sessionId, {
      chatId: finalDto.chatId,
      body: finalDto.text,
      type: 'text',
    });

    try {
      const result = await engine.sendTextMessage(finalDto.chatId, finalDto.text);

      // Update with actual WhatsApp message ID and status
      message.waMessageId = result.id;
      message.status = MessageStatus.SENT;
      message.timestamp = result.timestamp;
      await this.messageRepository.save(message);

      // Execute hook after successful send
      await this.hookManager.execute(
        'message:sent',
        { sessionId, result, input: finalDto },
        { sessionId, source: 'MessageService' },
      );

      return {
        messageId: result.id,
        timestamp: result.timestamp,
      };
    } catch (error) {
      // Mark as failed
      message.status = MessageStatus.FAILED;
      await this.messageRepository.save(message);

      // Execute hook on failure
      await this.hookManager.execute(
        'message:failed',
        { sessionId, error: error instanceof Error ? error.message : String(error), input: finalDto },
        { sessionId, source: 'MessageService' },
      );

      throw error;
    }
  }

  async sendImage(sessionId: string, dto: SendMediaMessageDto): Promise<MessageResponseDto> {
    const engine = this.getEngine(sessionId);
    const media = this.buildMediaInput(dto);

    // Save message as pending BEFORE sending
    const message = await this.saveOutgoingMessage(sessionId, {
      chatId: dto.chatId,
      body: dto.caption || '',
      type: 'image',
    });

    try {
      const result = await engine.sendImageMessage(dto.chatId, media);

      // Update with actual WhatsApp message ID and status
      message.waMessageId = result.id;
      message.status = MessageStatus.SENT;
      message.timestamp = result.timestamp;
      await this.messageRepository.save(message);

      return {
        messageId: result.id,
        timestamp: result.timestamp,
      };
    } catch (error) {
      message.status = MessageStatus.FAILED;
      await this.messageRepository.save(message);
      throw error;
    }
  }

  async sendVideo(sessionId: string, dto: SendMediaMessageDto): Promise<MessageResponseDto> {
    const engine = this.getEngine(sessionId);
    const media = this.buildMediaInput(dto);

    // Save message as pending BEFORE sending
    const message = await this.saveOutgoingMessage(sessionId, {
      chatId: dto.chatId,
      body: dto.caption || '',
      type: 'video',
    });

    try {
      const result = await engine.sendVideoMessage(dto.chatId, media);

      // Update with actual WhatsApp message ID and status
      message.waMessageId = result.id;
      message.status = MessageStatus.SENT;
      message.timestamp = result.timestamp;
      await this.messageRepository.save(message);

      return {
        messageId: result.id,
        timestamp: result.timestamp,
      };
    } catch (error) {
      message.status = MessageStatus.FAILED;
      await this.messageRepository.save(message);
      throw error;
    }
  }

  async sendAudio(sessionId: string, dto: SendMediaMessageDto): Promise<MessageResponseDto> {
    const engine = this.getEngine(sessionId);
    const media = this.buildMediaInput(dto);

    // Save message as pending BEFORE sending
    const message = await this.saveOutgoingMessage(sessionId, {
      chatId: dto.chatId,
      type: 'audio',
    });

    try {
      const result = await engine.sendAudioMessage(dto.chatId, media);

      // Update with actual WhatsApp message ID and status
      message.waMessageId = result.id;
      message.status = MessageStatus.SENT;
      message.timestamp = result.timestamp;
      await this.messageRepository.save(message);

      return {
        messageId: result.id,
        timestamp: result.timestamp,
      };
    } catch (error) {
      message.status = MessageStatus.FAILED;
      await this.messageRepository.save(message);
      throw error;
    }
  }

  async sendDocument(sessionId: string, dto: SendMediaMessageDto): Promise<MessageResponseDto> {
    const engine = this.getEngine(sessionId);
    const media = this.buildMediaInput(dto);

    // Save message as pending BEFORE sending
    const message = await this.saveOutgoingMessage(sessionId, {
      chatId: dto.chatId,
      body: dto.filename || '',
      type: 'document',
    });

    try {
      const result = await engine.sendDocumentMessage(dto.chatId, media);

      // Update with actual WhatsApp message ID and status
      message.waMessageId = result.id;
      message.status = MessageStatus.SENT;
      message.timestamp = result.timestamp;
      await this.messageRepository.save(message);

      return {
        messageId: result.id,
        timestamp: result.timestamp,
      };
    } catch (error) {
      message.status = MessageStatus.FAILED;
      await this.messageRepository.save(message);
      throw error;
    }
  }

  /**
   * Get message history for a session
   */
  async getMessages(
    sessionId: string,
    options: GetMessagesOptions = {},
  ): Promise<{ messages: Message[]; total: number }> {
    const { chatId, limit = 50, offset = 0 } = options;

    const query = this.messageRepository
      .createQueryBuilder('message')
      .where('message.sessionId = :sessionId', { sessionId })
      .orderBy('message.createdAt', 'DESC')
      .skip(offset)
      .take(limit);

    if (chatId) {
      query.andWhere('message.chatId = :chatId', { chatId });
    }

    const [messages, total] = await query.getManyAndCount();
    return {
      messages: messages.map(message => this.normalizeMessageSender(message)),
      total,
    };
  }

  async getMessageById(
    sessionId: string,
    messageId: string,
  ): Promise<Message & { hasReply: boolean; quotedMessageId: string | null; quotedMessageBody: string | null }> {
    const message = await this.messageRepository.findOne({
      where: [
        { sessionId, id: messageId },
        { sessionId, waMessageId: messageId },
      ],
      order: { createdAt: 'DESC' },
    });

    if (!message) {
      throw new NotFoundException(`Message '${messageId}' not found in session '${sessionId}'`);
    }

    const metadata = this.parseMetadata(message.metadata);
    const quotedMessage =
      metadata.quotedMessage && typeof metadata.quotedMessage === 'object'
        ? (metadata.quotedMessage as Record<string, unknown>)
        : null;

    const quotedMessageId =
      typeof metadata.quotedMessageId === 'string'
        ? metadata.quotedMessageId
        : quotedMessage && typeof quotedMessage.id === 'string'
          ? quotedMessage.id
          : null;

    const quotedMessageBody = quotedMessage && typeof quotedMessage.body === 'string' ? quotedMessage.body : null;
    const normalizedMessage = this.normalizeMessageSender(message);

    return {
      ...normalizedMessage,
      hasReply: !!quotedMessageId,
      quotedMessageId,
      quotedMessageBody,
    };
  }

  async getRepliesToMessage(
    sessionId: string,
    messageId: string,
  ): Promise<{ message: Message; replies: Message[]; total: number }> {
    const sourceMessage = await this.findMessageRecordByAnyId(sessionId, messageId);

    const candidateQuotedIds = new Set<string>();
    for (const id of [messageId, sourceMessage?.id, sourceMessage?.waMessageId]) {
      if (typeof id !== 'string' || id.length === 0) {
        continue;
      }
      for (const variant of this.getMessageIdVariants(id)) {
        candidateQuotedIds.add(this.normalizeComparableMessageId(variant));
      }
    }

    const sessionMessages = await this.messageRepository.find({
      where: { sessionId },
      order: { createdAt: 'ASC' },
    });

    const replies = sessionMessages.filter(message => {
      if (sourceMessage && message.id === sourceMessage.id) {
        return false;
      }

      const metadata = this.parseMetadata(message.metadata);
      const quotedMessageId =
        typeof metadata.quotedMessageId === 'string' && metadata.quotedMessageId.length > 0
          ? metadata.quotedMessageId
          : null;

      return quotedMessageId !== null && candidateQuotedIds.has(this.normalizeComparableMessageId(quotedMessageId));
    });

    if (!sourceMessage && replies.length === 0) {
      throw new NotFoundException(`Message '${messageId}' not found in session '${sessionId}'`);
    }

    const source =
      sourceMessage ??
      ({
        id: messageId,
        sessionId,
        waMessageId: messageId,
        chatId: this.extractChatIdFromWaMessageId(messageId) ?? replies[0]?.chatId ?? 'unknown',
        from: this.extractChatIdFromWaMessageId(messageId) ?? 'unknown',
        to: '',
        body: '',
        type: 'text',
        direction: MessageDirection.INCOMING,
        timestamp: undefined,
        status: MessageStatus.DELIVERED,
        metadata: {
          virtual: true,
          source: 'replies-fallback',
        },
        createdAt: new Date(),
      } as Message);

    return {
      message: this.normalizeMessageSender(source),
      replies: replies.map(message => this.normalizeMessageSender(message)),
      total: replies.length,
    };
  }

  // ========== Phase 3: Extended Messaging ==========

  async sendLocation(
    sessionId: string,
    dto: { chatId: string; latitude: number; longitude: number; description?: string; address?: string },
  ): Promise<MessageResponseDto> {
    const engine = this.getEngine(sessionId);

    // Save message as pending BEFORE sending
    const message = await this.saveOutgoingMessage(sessionId, {
      chatId: dto.chatId,
      body: `📍 ${dto.description || 'Location'}`,
      type: 'location',
    });

    try {
      const result = await engine.sendLocationMessage(dto.chatId, {
        latitude: dto.latitude,
        longitude: dto.longitude,
        description: dto.description,
        address: dto.address,
      });

      // Update with actual WhatsApp message ID and status
      message.waMessageId = result.id;
      message.status = MessageStatus.SENT;
      message.timestamp = result.timestamp;
      await this.messageRepository.save(message);

      return {
        messageId: result.id,
        timestamp: result.timestamp,
      };
    } catch (error) {
      message.status = MessageStatus.FAILED;
      await this.messageRepository.save(message);
      throw error;
    }
  }

  async sendContact(
    sessionId: string,
    dto: { chatId: string; contactName: string; contactNumber: string },
  ): Promise<MessageResponseDto> {
    const engine = this.getEngine(sessionId);

    // Save message as pending BEFORE sending
    const message = await this.saveOutgoingMessage(sessionId, {
      chatId: dto.chatId,
      body: `📇 ${dto.contactName}`,
      type: 'contact',
    });

    try {
      const result = await engine.sendContactMessage(dto.chatId, {
        name: dto.contactName,
        number: dto.contactNumber,
      });

      // Update with actual WhatsApp message ID and status
      message.waMessageId = result.id;
      message.status = MessageStatus.SENT;
      message.timestamp = result.timestamp;
      await this.messageRepository.save(message);

      return {
        messageId: result.id,
        timestamp: result.timestamp,
      };
    } catch (error) {
      message.status = MessageStatus.FAILED;
      await this.messageRepository.save(message);
      throw error;
    }
  }

  async sendSticker(sessionId: string, dto: SendMediaMessageDto): Promise<MessageResponseDto> {
    const engine = this.getEngine(sessionId);
    const media = this.buildMediaInput(dto);

    // Save message as pending BEFORE sending
    const message = await this.saveOutgoingMessage(sessionId, {
      chatId: dto.chatId,
      type: 'sticker',
    });

    try {
      const result = await engine.sendStickerMessage(dto.chatId, media);

      // Update with actual WhatsApp message ID and status
      message.waMessageId = result.id;
      message.status = MessageStatus.SENT;
      message.timestamp = result.timestamp;
      await this.messageRepository.save(message);

      return {
        messageId: result.id,
        timestamp: result.timestamp,
      };
    } catch (error) {
      message.status = MessageStatus.FAILED;
      await this.messageRepository.save(message);
      throw error;
    }
  }

  async reply(
    sessionId: string,
    dto: { chatId: string; quotedMessageId: string; text: string },
  ): Promise<MessageResponseDto> {
    const engine = this.getEngine(sessionId);

    // Save message as pending BEFORE sending
    const message = await this.saveOutgoingMessage(sessionId, {
      chatId: dto.chatId,
      body: dto.text,
      type: 'text',
    });

    try {
      const result = await engine.replyToMessage(dto.chatId, dto.quotedMessageId, dto.text);

      // Update with actual WhatsApp message ID and status
      message.waMessageId = result.id;
      message.status = MessageStatus.SENT;
      message.timestamp = result.timestamp;
      message.metadata = {
        ...(message.metadata || {}),
        hasReply: true,
        quotedMessageId: dto.quotedMessageId,
      };
      await this.messageRepository.save(message);

      return {
        messageId: result.id,
        timestamp: result.timestamp,
      };
    } catch (error) {
      message.status = MessageStatus.FAILED;
      await this.messageRepository.save(message);
      throw error;
    }
  }

  async replyByMessageId(
    sessionId: string,
    dto: { quotedMessageId: string; text: string; chatId?: string },
  ): Promise<MessageResponseDto> {
    let targetChatId = dto.chatId;

    if (!targetChatId) {
      const sourceMessage = await this.findMessageRecordByAnyId(sessionId, dto.quotedMessageId);

      targetChatId = sourceMessage?.chatId ?? this.extractChatIdFromWaMessageId(dto.quotedMessageId);

      if (!targetChatId) {
        throw new NotFoundException(
          `Cannot resolve chat for message '${dto.quotedMessageId}'. Provide chatId or ensure message exists in history.`,
        );
      }
    }

    if (!targetChatId) {
      throw new BadRequestException('chatId is required to reply to this message');
    }

    return this.reply(sessionId, {
      chatId: targetChatId,
      quotedMessageId: dto.quotedMessageId,
      text: dto.text,
    });
  }

  async forward(
    sessionId: string,
    dto: { fromChatId: string; toChatId: string; messageId: string },
  ): Promise<MessageResponseDto> {
    const engine = this.getEngine(sessionId);

    // Save message as pending BEFORE sending
    const message = await this.saveOutgoingMessage(sessionId, {
      chatId: dto.toChatId,
      body: '[Forwarded]',
      type: 'forward',
    });

    try {
      const result = await engine.forwardMessage(dto.fromChatId, dto.toChatId, dto.messageId);

      // Update with actual WhatsApp message ID and status
      message.waMessageId = result.id;
      message.status = MessageStatus.SENT;
      message.timestamp = result.timestamp;
      await this.messageRepository.save(message);

      return {
        messageId: result.id,
        timestamp: result.timestamp,
      };
    } catch (error) {
      message.status = MessageStatus.FAILED;
      await this.messageRepository.save(message);
      throw error;
    }
  }

  /**
   * Save incoming message (called from session webhook dispatch)
   */
  async saveIncomingMessage(sessionId: string, data: Partial<Message>): Promise<Message> {
    const message = this.messageRepository.create({
      ...data,
      sessionId,
      direction: MessageDirection.INCOMING,
    });
    return this.messageRepository.save(message);
  }

  /**
   * Save outgoing message to database.
   * When called before sending, creates a record with PENDING status.
   */
  private async saveOutgoingMessage(
    sessionId: string,
    data: {
      waMessageId?: string;
      chatId: string;
      body?: string;
      type: string;
      timestamp?: number;
      status?: MessageStatus;
    },
  ): Promise<Message> {
    const session = await this.sessionService.findOne(sessionId);
    const message = this.messageRepository.create({
      sessionId,
      waMessageId: data.waMessageId,
      chatId: data.chatId,
      from: session?.phone || 'me',
      to: data.chatId,
      body: data.body,
      type: data.type,
      direction: MessageDirection.OUTGOING,
      timestamp: data.timestamp,
      status: data.status ?? MessageStatus.PENDING,
    });
    return this.messageRepository.save(message);
  }

  // ========== Phase 3: Reactions ==========

  async reactToMessage(sessionId: string, dto: { chatId: string; messageId: string; emoji: string }): Promise<void> {
    const engine = this.getEngine(sessionId);
    await engine.reactToMessage(dto.chatId, dto.messageId, dto.emoji);
  }

  async getMessageReactions(sessionId: string, chatId: string, messageId: string) {
    const engine = this.getEngine(sessionId);
    return engine.getMessageReactions(chatId, messageId);
  }

  // ========== Delete Message ==========

  async deleteMessage(
    sessionId: string,
    dto: { chatId: string; messageId: string; forEveryone?: boolean },
  ): Promise<void> {
    const engine = this.getEngine(sessionId);
    await engine.deleteMessage(dto.chatId, dto.messageId, dto.forEveryone ?? true);
  }

  private getEngine(sessionId: string) {
    const engine = this.sessionService.getEngine(sessionId);
    if (!engine) {
      throw new BadRequestException(`Session '${sessionId}' is not active. Start the session first.`);
    }
    return engine;
  }

  private buildMediaInput(dto: SendMediaMessageDto): MediaInput {
    if (!dto.url && !dto.base64) {
      throw new BadRequestException('Either url or base64 must be provided');
    }

    if (dto.base64 && !dto.mimetype) {
      throw new BadRequestException('mimetype is required when using base64 data');
    }

    return {
      mimetype: dto.mimetype || 'application/octet-stream',
      data: dto.url || dto.base64!,
      filename: dto.filename,
      caption: dto.caption,
    };
  }

  private parseMetadata(metadata: Record<string, unknown> | null | undefined): Record<string, unknown> {
    if (!metadata) {
      return {};
    }

    if (typeof metadata === 'string') {
      try {
        const parsed = JSON.parse(metadata) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        return {};
      }
      return {};
    }

    if (typeof metadata === 'object' && !Array.isArray(metadata)) {
      return metadata;
    }

    return {};
  }

  private async findMessageRecordByAnyId(sessionId: string, messageId: string): Promise<Message | null> {
    const variants = this.getMessageIdVariants(messageId);

    return this.messageRepository.findOne({
      where: [
        ...variants.map(variant => ({ sessionId, id: variant })),
        ...variants.map(variant => ({ sessionId, waMessageId: variant })),
      ],
      order: { createdAt: 'DESC' },
    });
  }

  private extractChatIdFromWaMessageId(messageId: string): string | null {
    if (!messageId) {
      return null;
    }

    const match = messageId.match(/^(?:true|false)_([^_]+)_/);
    if (!match) {
      return null;
    }

    const chatId = match[1]?.trim();
    if (!chatId || !chatId.includes('@')) {
      return null;
    }

    return chatId;
  }

  private getMessageIdVariants(messageId: string): string[] {
    const id = messageId.trim();
    if (!id) {
      return [];
    }

    const variants = new Set<string>([id]);
    if (id.startsWith('true_')) {
      variants.add(`false_${id.slice(5)}`);
    } else if (id.startsWith('false_')) {
      variants.add(`true_${id.slice(6)}`);
    }

    return [...variants];
  }

  private normalizeComparableMessageId(messageId: string): string {
    return messageId.trim().replace(/^(?:true|false)_/, '');
  }

  private normalizeMessageSender(message: Message): Message {
    const from = typeof message.from === 'string' ? message.from : '';
    const chatId = typeof message.chatId === 'string' ? message.chatId : '';
    const isGroupMessage = chatId.endsWith('@g.us') || from.endsWith('@g.us');

    if (!isGroupMessage || !from.endsWith('@g.us')) {
      return message;
    }

    const metadata = this.parseMetadata(message.metadata);
    const senderId = this.resolveGroupSenderId(metadata);

    return {
      ...message,
      from: senderId ?? 'unknown',
    };
  }

  private resolveGroupSenderId(metadata: Record<string, unknown>): string | null {
    const candidates = [metadata.author, metadata.userId, metadata.from];

    for (const candidate of candidates) {
      if (typeof candidate !== 'string') {
        continue;
      }

      const value = candidate.trim();
      if (value && !value.endsWith('@g.us')) {
        return value;
      }
    }

    return null;
  }
}
