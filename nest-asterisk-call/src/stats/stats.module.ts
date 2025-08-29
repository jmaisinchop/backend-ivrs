import { Module } from '@nestjs/common';
import { StatsService } from './stats.service';
import { StatsController } from './stats.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Campaign } from 'src/campaign/campaign.entity';
import { Contact } from 'src/campaign/contact.entity';
import { ChannelLimit } from 'src/channel-limit/channel-limit.entity';
import { WhatsappCampaign } from 'src/whatsapp-campaign/whatsapp-campaign.entity';
import { WhatsappContact } from 'src/whatsapp-campaign/whatsapp-contact.entity';

@Module({
  imports: [

    TypeOrmModule.forFeature([
      Campaign,
      Contact,
      ChannelLimit,
      WhatsappCampaign,
      WhatsappContact, 
    ]),
  ],
  providers: [StatsService],
  controllers: [StatsController],
})
export class StatsModule {}