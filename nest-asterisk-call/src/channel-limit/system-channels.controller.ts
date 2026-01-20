import { Controller, Post, Body, Get, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { SystemChannels } from './system-channels.entity';

@UseGuards(AuthGuard('jwt'), RolesGuard)
@Controller('system-channels')
export class SystemChannelsController {
    constructor(
        @InjectRepository(SystemChannels)
        private readonly systemRepo: Repository<SystemChannels>,
    ) { }

    @Roles('ADMIN', 'SUPERVISOR')
    @Post('set')
    async setTotal(@Body() body: { totalChannels: number }) {
        let config = await this.systemRepo.findOne({ where: {} });
        if (!config) {
            config = this.systemRepo.create({ totalChannels: body.totalChannels });
        } else {
            config.totalChannels = body.totalChannels;
        }
        return this.systemRepo.save(config);
    }

    @Get('total')
    async getTotal() {
        const config = await this.systemRepo.findOne({ where: {} });
        return { totalChannels: config?.totalChannels || 0 };
    }
}
