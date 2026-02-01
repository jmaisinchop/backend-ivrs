import { Module, forwardRef } from '@nestjs/common';
import { AmiService } from './ami.service';
import { HttpModule } from '@nestjs/axios';
import { CampaignModule } from 'src/campaign/campaign.module';
import { DashboardModule } from 'src/dashboard/dashboard.module';
import { PostCallModule } from 'src/post-call/post-call.module';
import { AmiController } from './ami.controller';

@Module({
  imports: [
    HttpModule,
    forwardRef(() => CampaignModule),
    forwardRef(() => PostCallModule),
    DashboardModule
  ],
  providers: [AmiService],
  exports: [AmiService],
  controllers: [AmiController], 
})
export class AmiModule {}