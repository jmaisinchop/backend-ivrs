import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';

import { PostCallMenu } from './post-call-menu.entity';
import { Commitment } from './commitment.entity';
import { AgentCallEvent } from './agent-call-event.entity';
import { AgentBreak } from './agent-break.entity';
import { User } from '../user/user.entity';
import { Contact } from '../campaign/contact.entity'; 
import { Campaign } from '../campaign/campaign.entity';

import { PostCallService } from './post-call.service';
import { PostCallController } from './post-call.controller';
import { AgentService } from './agent.service';

import { CampaignModule } from '../campaign/campaign.module';
import { DashboardModule } from '../dashboard/dashboard.module';
import { AmiModule } from '../ami/ami.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      PostCallMenu, 
      Commitment, 
      AgentCallEvent,
      AgentBreak,     // ← AGREGADO para tracking de descansos
      User, 
      Contact,
      Campaign,
    ]),
    HttpModule,
    ConfigModule,
    forwardRef(() => CampaignModule),
    forwardRef(() => AmiModule),
    forwardRef(() => DashboardModule),
  ],
  providers: [PostCallService, AgentService],
  controllers: [PostCallController],
  exports: [PostCallService, AgentService],
})
export class PostCallModule {}