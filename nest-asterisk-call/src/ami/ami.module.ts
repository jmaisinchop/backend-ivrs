import { Module, forwardRef } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { AmiService } from './ami.service';
import { AmiController } from './ami.controller';
import { CampaignModule } from '../campaign/campaign.module';

@Module({
  imports: [
    HttpModule,
    // Necesitamos el CampaignModule por la referencia cruzada (CampaignService),
    // uso forwardRef para evitar problemas circulares
    forwardRef(() => CampaignModule),
  ],
  controllers: [AmiController],
  providers: [AmiService],
  exports: [AmiService],
})
export class AmiModule {}
