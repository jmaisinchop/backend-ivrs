import { Module } from '@nestjs/common';
import { ContactosService } from './contactos.service';
import { ContactosController } from './contactos.controller';

@Module({
  providers: [ContactosService],
  controllers: [ContactosController]
})
export class ContactosModule {}
