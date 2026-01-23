import { Injectable, CanActivate, ExecutionContext, ForbiddenException, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { User } from '../user/user.entity';

export const RequirePermission = (permission: 'ivrs') => SetMetadata('permission', permission);

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredPermission = this.reflector.get<'ivrs'>(
      'permission',
      context.getHandler(),
    );

    if (!requiredPermission) {
      return true;
    }

    const { user }: { user: User } = context.switchToHttp().getRequest();

    if (!user) {
      return false;
    }

    if (requiredPermission === 'ivrs' && !user.canAccessIvrs) {
      throw new ForbiddenException('No tienes permiso para acceder a este módulo.');
    }

    return true;
  }
}