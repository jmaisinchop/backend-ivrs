import { Controller, Post, Body, UseGuards, Req, HttpCode, HttpStatus, Get } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthGuard } from '@nestjs/passport';

@Controller('auth')
export class AuthController {
    constructor(private authService: AuthService) { }

    @UseGuards(AuthGuard('local')) 
    @Post('login')
    @HttpCode(HttpStatus.OK)
    async login(@Req() req) {
        return this.authService.login(req.user);
    }

    @UseGuards(AuthGuard('jwt')) 
    @Post('logout')
    @HttpCode(HttpStatus.OK)
    async logout(@Req() req) {

        const userId = req.user.id;
        await this.authService.logout(userId);
        return { message: 'Sesión cerrada y token invalidado exitosamente.' };
    }

    @Post('force/logout')
    @HttpCode(HttpStatus.OK)
    async forceLogout(@Body() body: { userId: string }) {
        await this.authService.logout(body.userId);
        return { message: 'Forzado logout sin token' };
    }
    @UseGuards(AuthGuard('jwt'))
    @Get('me') 
    getProfile(@Req() req) {
        return this.authService.getProfile(req.user.id);
    }
}