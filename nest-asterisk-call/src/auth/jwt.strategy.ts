import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Request } from 'express';
import { UserService } from '../user/user.service';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  private readonly tokenCache = new Map<string, { user: any; timestamp: number }>();
  private readonly CACHE_TTL = 60000;

  constructor(
    private readonly userService: UserService,
    private readonly configService: ConfigService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('JWT_SECRET'),
      passReqToCallback: true,
    });

    this.startCacheCleanup();
  }

  private startCacheCleanup(): void {
    setInterval(() => {
      const now = Date.now();
      for (const [token, data] of this.tokenCache.entries()) {
        if (now - data.timestamp > this.CACHE_TTL) {
          this.tokenCache.delete(token);
        }
      }
    }, 120000);
  }

  async validate(req: Request, payload: any) {
    if (!payload || !payload.sub) {
      throw new UnauthorizedException('Token inválido - payload corrupto');
    }

    const token = ExtractJwt.fromAuthHeaderAsBearerToken()(req);
    
    if (!token) {
      throw new UnauthorizedException('Token no proporcionado');
    }

    const cached = this.tokenCache.get(token);
    const now = Date.now();

    if (cached && (now - cached.timestamp) < this.CACHE_TTL) {
      return cached.user;
    }

    const user = await this.userService.findById(payload.sub);
    
    if (!user) {
      throw new UnauthorizedException('Usuario no existe');
    }

    if (!user.currentToken) {
      throw new UnauthorizedException('Sesión cerrada - por favor inicia sesión nuevamente');
    }

    if (user.currentToken !== token) {
      throw new UnauthorizedException('Token inválido - sesión iniciada en otro dispositivo');
    }

    this.tokenCache.set(token, {
      user,
      timestamp: now
    });

    return user;
  }

  clearCache(): void {
    this.tokenCache.clear();
  }

  invalidateToken(token: string): void {
    this.tokenCache.delete(token);
  }
}