import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { WhatsappCampaign } from './whatsapp-campaign.entity';
import { WhatsappContact } from './whatsapp-contact.entity';
import { User } from '../user/user.entity';
import { WhatsappCampaignService } from './whatsapp-campaign.service';
import { WhatsappCampaignController } from './whatsapp-campaign.controller';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { WhatsappConfigController } from './whatsapp-config.controller';
import { WhatsappConfig } from './whatsapp-config.entity';
@Module({
  imports: [
    ConfigModule, 
    TypeOrmModule.forFeature([WhatsappCampaign, WhatsappContact,WhatsappConfig, User]),
    ClientsModule.registerAsync([ 
      {
        name: 'WHATSAPP_SERVICE_CLIENT',
        imports: [ConfigModule], 
        inject: [ConfigService], 
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
  providers: [WhatsappCampaignService],
  controllers: [WhatsappCampaignController,WhatsappConfigController],
})
export class WhatsappCampaignModule {}