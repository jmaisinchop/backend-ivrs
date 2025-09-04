import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-local';
import { AuthService } from './auth.service';

@Injectable()
export class LocalStrategy extends PassportStrategy(Strategy) {
  constructor(private authService: AuthService) {
    // Aquí puedes configurar campos personalizados, por ej. usernameField: 'email'
    // Lo dejamos con los valores por defecto que usan 'username' y 'password'.
    super();
  }

  /**
   * NestJS llama a este método automáticamente cuando usas el AuthGuard('local').
   * Recibe el usuario y la contraseña del cuerpo de la petición.
   */
  async validate(username: string, password: string): Promise<any> {
    const user = await this.authService.validateUser(username, password);
    
    if (!user) {
      throw new UnauthorizedException('Credenciales incorrectas.');
    }
    
    return user;
  }
}