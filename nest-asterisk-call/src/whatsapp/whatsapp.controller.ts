import { Controller, Post, Body, Req, UseGuards, Get, Inject } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ClientProxy } from '@nestjs/microservices';
import { lastValueFrom } from 'rxjs';
import { PermissionGuard, RequirePermission } from '../auth/permissions.guard';

@UseGuards(AuthGuard('jwt'), PermissionGuard)
@Controller('whatsapp')
export class WhatsappController {
    constructor(@Inject('WHATSAPP_SERVICE') private client: ClientProxy) { }

    @Post('start-session')
    @RequirePermission('whatsapp')
    startSession(@Req() req) {
        const userId = req.user.id;
        this.client.emit('start-session', { userId });
        return { message: 'Solicitud para iniciar sesión enviada al microservicio.' };
    }

    @Post('send-message')
    @RequirePermission('whatsapp')
    sendMessage(@Req() req, @Body('to') to: string, @Body('text') text: string) {
        const userId = req.user.id;
        this.client.emit('send-message', { userId, to, text });
        return { message: 'Mensaje encolado para ser enviado por el microservicio.' };
    }

    @Get('status')
    @RequirePermission('whatsapp')
    async getStatus(@Req() req) {
        const userId = req.user.id;
        const response = await lastValueFrom(
            this.client.send('get-status', { userId })
        );
        return response;
    }
}