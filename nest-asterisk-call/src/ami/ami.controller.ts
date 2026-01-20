import { Controller, Post, Body } from '@nestjs/common';
import { AmiService } from './ami.service';

@Controller('ami')
export class AmiController {
  constructor(private readonly amiService: AmiService) {}

  @Post('call')
  async testCall(
    @Body() body: { texto: string; numero: string; contactId?: string },
  ) {
    const contactId = body.contactId || 'manualCall';
    await this.amiService.callWithTTS(body.texto, body.numero, contactId);
    return { message: 'Llamada TTS lanzada en segundo plano' };
  }
}
