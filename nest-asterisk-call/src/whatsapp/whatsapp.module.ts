import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { WhatsappController } from './whatsapp.controller';
import { ConfigModule, ConfigService } from '@nestjs/config';

@Module({
  imports: [
    ClientsModule.registerAsync([ // Usar registerAsync
      {
        name: 'WHATSAPP_SERVICE',
        imports: [ConfigModule], // Importar ConfigModule
        inject: [ConfigService], // Inyectar ConfigService
        useFactory: (configService: ConfigService) => ({
          transport: Transport.REDIS,
          options: {
            host: configService.get<string>('REDIS_HOST'),
            port: configService.get<number>('REDIS_PORT'),
          },
        }),
      },
    ]),
  ],
  controllers: [WhatsappController],
})
export class WhatsappModule {}