import { Module, forwardRef } from '@nestjs/common';
import { WhatsappService } from './whatsapp.service';
import { EventsModule } from '../events/events.module';

@Module({
  imports: [forwardRef(() => EventsModule)],
  providers: [WhatsappService],
  exports: [WhatsappService], // Exportamos el servicio para usarlo en el controlador principal
})
export class WhatsappModule {}