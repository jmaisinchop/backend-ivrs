import { Injectable, CanActivate, ExecutionContext, ForbiddenException, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { User } from '../user/user.entity';

// Creamos un decorador para aplicar los permisos de forma sencilla
export const RequirePermission = (permission: 'ivrs' | 'whatsapp') => SetMetadata('permission', permission);

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredPermission = this.reflector.get<'ivrs' | 'whatsapp'>(
      'permission',
      context.getHandler(),
    );

    // Si la ruta no requiere un permiso específico, permite el acceso
    if (!requiredPermission) {
      return true;
    }

    const { user }: { user: User } = context.switchToHttp().getRequest();

    // Si no hay usuario, el AuthGuard ya debería haberlo bloqueado, pero es una doble verificación
    if (!user) {
      return false;
    }

    let hasPermission = false;
    if (requiredPermission === 'ivrs') {
      hasPermission = user.canAccessIvrs;
    } else if (requiredPermission === 'whatsapp') {
      hasPermission = user.canAccessWhatsapp;
    }

    if (!hasPermission) {
      throw new ForbiddenException('No tienes permiso para acceder a este módulo.');
    }

    return true;
  }
}