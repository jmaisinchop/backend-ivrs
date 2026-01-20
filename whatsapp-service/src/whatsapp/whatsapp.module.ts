import { Module, forwardRef } from '@nestjs/common';
import { WhatsappService } from './whatsapp.service';
import { EventsModule } from '../events/events.module';

@Module({
  imports: [forwardRef(() => EventsModule)],
  providers: [WhatsappService],
  exports: [WhatsappService],
})
export class WhatsappModule {}