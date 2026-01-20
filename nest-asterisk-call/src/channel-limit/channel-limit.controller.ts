import { Controller, Post, Body, UseGuards, Get, Put, Param } from '@nestjs/common';
import { ChannelLimitService } from './channel-limit.service';
import { UserService } from '../user/user.service';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { AuthGuard } from '@nestjs/passport';

@UseGuards(AuthGuard('jwt'), RolesGuard)
@Controller('channel-limit')
export class ChannelLimitController {
    constructor(
        private readonly channelLimitService: ChannelLimitService,
        private readonly userService: UserService,
    ) { }

    @Roles('ADMIN', 'SUPERVISOR')
    @Post('assign')
    async assign(
        @Body() body: { userId: string; maxChannels: number },
    ) {
        const user = await this.userService.findById(body.userId);
        if (!user) throw new Error('Usuario no encontrado');
        return this.channelLimitService.assignChannels(user, body.maxChannels);
    }

    @Roles('ADMIN', 'SUPERVISOR')
    @Get('all')
    async getAll() {
        return this.channelLimitService.getAllLimits();
    }
    @Roles('ADMIN', 'SUPERVISOR')
    @Put('update')
    async updateLimit(
        @Body() body: { userId: string; newMaxChannels: number },
    ) {
        const user = await this.userService.findById(body.userId);
        if (!user) throw new Error('Usuario no encontrado');

        return this.channelLimitService.assignChannels(user, body.newMaxChannels);
    }
    @Get(':userId')
    async getLimitForUser(@Param('userId') userId: string) {
        const limit = await this.channelLimitService.getUserLimit(userId);
        return { userId, maxChannels: limit };
    }

}
