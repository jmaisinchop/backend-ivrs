import { Controller } from '@nestjs/common';
import { MessagePattern, Payload,EventPattern } from '@nestjs/microservices';
import { WhatsappService } from './whatsapp/whatsapp.service';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';

@Controller()
export class AppController {
  private readonly internalApiSecret: string;
  private readonly monolithApiUrl: string;

  constructor(
    private readonly whatsappService: WhatsappService,
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    const secret = this.configService.get<string>('INTERNAL_API_SECRET');
    const apiUrl = this.configService.get<string>('MONOLITH_API_URL');

    if (!secret || !apiUrl) {
      throw new Error(
        'ERROR FATAL: Las variables INTERNAL_API_SECRET y/o MONOLITH_API_URL no están definidas en el archivo .env del whatsapp-service.',
      );
    }

    this.internalApiSecret = secret;
    this.monolithApiUrl = apiUrl;
  }

  @MessagePattern('start-session')
  handleStartSession(@Payload() data: { userId: string }) {
    this.whatsappService.startSession(data.userId);
  }

  @MessagePattern('send-message')
  handleSendMessage(@Payload() data: { userId: string, to: string, text: string }) {
    this.whatsappService.sendMessage(data.userId, data.to, data.text);
  }

  @MessagePattern('get-status')
  handleGetStatus(@Payload() data: { userId: string }) {
    return this.whatsappService.initializeUserSession(data.userId);
  }

  @MessagePattern('send-campaign-message')
  async handleSendCampaignMessage(@Payload() data: { userId: string, to: string, text: string, contactId: string }) {
    const requestConfig = {
      headers: {
        'x-internal-api-secret': this.internalApiSecret,
      },
    };
    const updateStatusUrl = `${this.monolithApiUrl}/whatsapp-campaigns/contacts/${data.contactId}/status`;

    try {
      await this.whatsappService.sendMessage(data.userId, data.to, data.text);

      this.httpService.post(updateStatusUrl,
        { status: 'SENT' },
        requestConfig
      ).subscribe();

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.httpService.post(updateStatusUrl,
        { status: 'FAILED', errorMessage: errorMessage },
        requestConfig
      ).subscribe();
    }
  }
  @MessagePattern('health') 
  handleHealthCheck() {
    return { status: 'ok' };
  }

  // --- NUEVO: EVENTO DE PRESENCIA (ESCRIBIENDO...) ---
  @EventPattern('send-presence')
  async handleSendPresence(@Payload() data: { userId: string, to: string, state: 'composing' | 'paused' }) {
    await this.whatsappService.sendPresence(data.userId, data.to, data.state);
  }
}