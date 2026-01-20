import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ChannelLimit }      from './channel-limit.entity';
import { SystemChannels }    from './system-channels.entity';
import { Campaign }          from '../campaign/campaign.entity';    // ←
import { ChannelLimitService }    from './channel-limit.service';
import { ChannelLimitController } from './channel-limit.controller';
import { SystemChannelsController } from './system-channels.controller';
import { UserModule }        from '../user/user.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ChannelLimit,
      SystemChannels,
      Campaign,
    ]),
    UserModule,
  ],
  providers: [ChannelLimitService],
  controllers: [ChannelLimitController, SystemChannelsController],
  exports: [ChannelLimitService],
})
export class ChannelLimitModule {}
