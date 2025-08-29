import { Module, forwardRef } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { AmiService } from './ami.service';
import { AmiController } from './ami.controller';
import { CampaignModule } from '../campaign/campaign.module';
import { DashboardModule } from '../dashboard/dashboard.module';
@Module({
  imports: [
    HttpModule,
    forwardRef(() => CampaignModule),
    DashboardModule,
  ],
  controllers: [AmiController],
  providers: [AmiService],
  exports: [AmiService],
})
export class AmiModule {}
