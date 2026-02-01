import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';

import { PostCallMenu } from './post-call-menu.entity';
import { Commitment } from './commitment.entity';
import { AgentCallEvent } from './agent-call-event.entity';
import { User } from '../user/user.entity';                  // ← agregar

import { PostCallService } from './post-call.service';
import { PostCallController } from './post-call.controller';
import { AgentService } from './agent.service';

import { CampaignModule } from '../campaign/campaign.module';
import { DashboardModule } from '../dashboard/dashboard.module';
import { AmiModule } from '../ami/ami.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([PostCallMenu, Commitment, AgentCallEvent, User]),
    HttpModule,
    ConfigModule,
    forwardRef(() => CampaignModule),
    forwardRef(() => AmiModule),
    DashboardModule,
  ],
  providers: [PostCallService, AgentService],
  controllers: [PostCallController],
  exports: [PostCallService, AgentService],
})
export class PostCallModule {}