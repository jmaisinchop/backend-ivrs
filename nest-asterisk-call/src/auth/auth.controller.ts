import { Controller, Post, Body, UseGuards, Req, HttpCode, HttpStatus, Get } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthGuard } from '@nestjs/passport';

@Controller('auth')
export class AuthController {
    constructor(private authService: AuthService) { }

    @UseGuards(AuthGuard('local')) // El guard 'local' usa LocalStrategy para validar user/pass
    @Post('login')
    @HttpCode(HttpStatus.OK)
    async login(@Req() req) {
        // req.user aquí es el objeto que devuelve LocalStrategy
        return this.authService.login(req.user);
    }

    @UseGuards(AuthGuard('jwt')) // El guard 'jwt' usa JwtStrategy para validar el token
    @Post('logout')
    @HttpCode(HttpStatus.OK)
    async logout(@Req() req) {
        // ✅ CORRECCIÓN: Usamos req.user.id
        // req.user aquí es el objeto que devuelve JwtStrategy: { id, username, role }
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
    @Get('me') // Nuevo endpoint para obtener el perfil del usuario actual
    getProfile(@Req() req) {
        // req.user.id viene del token JWT validado
        return this.authService.getProfile(req.user.id);
    }
}