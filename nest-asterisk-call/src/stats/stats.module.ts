import { Module } from '@nestjs/common';
import { StatsService } from './stats.service';
import { StatsController } from './stats.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Campaign } from 'src/campaign/campaign.entity';
import { Contact } from 'src/campaign/contact.entity';
import { ChannelLimit } from 'src/channel-limit/channel-limit.entity';

@Module({
  imports: [

    TypeOrmModule.forFeature([
      Campaign,
      Contact,
      ChannelLimit,
    ]),
  ],
  providers: [StatsService],
  controllers: [StatsController],
})
export class StatsModule {}