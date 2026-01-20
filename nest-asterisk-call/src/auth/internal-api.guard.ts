import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class InternalApiGuard implements CanActivate {
  constructor(private configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const headerToken = request.headers['x-internal-api-secret'];
    const secretToken = this.configService.get<string>('INTERNAL_API_SECRET');

    if (!secretToken || headerToken !== secretToken) {
      throw new UnauthorizedException('Acceso interno no autorizado.');
    }
    return true;
  }
}