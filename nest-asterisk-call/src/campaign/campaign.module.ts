import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Campaign } from './campaign.entity';
import { Contact } from './contact.entity';
import { CampaignService } from './campaign.service';
import { CampaignController } from './campaign.controller';
import { AmiModule } from '../ami/ami.module';
import { ChannelLimitModule } from 'src/channel-limit/channel-limit.module';
import { DashboardModule } from '../dashboard/dashboard.module';
@Module({
  imports: [
    TypeOrmModule.forFeature([Campaign, Contact]),
    forwardRef(() => AmiModule),
    ChannelLimitModule, 
    DashboardModule,

  ],
  controllers: [CampaignController],
  providers: [CampaignService],
  exports: [CampaignService],
})
export class CampaignModule {}
