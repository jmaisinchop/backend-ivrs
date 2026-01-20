import { Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UserService } from '../user/user.service';
import * as bcrypt from 'bcrypt';
import { Cron, CronExpression } from '@nestjs/schedule';
import { User } from '../user/user.entity';
import { IsNull, Not, Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private userService: UserService,
    private jwtService: JwtService,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) { }

  async validateUser(username: string, pass: string): Promise<any> {
    const user = await this.userService.findByUsername(username);
    if (user && await bcrypt.compare(pass, user.password)) {
      const { password, ...result } = user;
      return result;
    }
    throw new UnauthorizedException('Credenciales inválidas');
  }

  async login(user: any) {
    const dbUser = await this.userService.findById(user.id);
    if (dbUser?.currentToken) {
      throw new UnauthorizedException(
        'Ya tienes una sesión activa. Cierra sesión desde el otro dispositivo antes de continuar.',
      );
    }

    const payload = { username: user.username, sub: user.id, role: user.role };
    const token = this.jwtService.sign(payload);

    await this.userService.updateCurrentToken(user.id, token);

    return {
      access_token: token,
      user: dbUser,
    };
  }

  async logout(userId: string) {
    await this.userService.updateCurrentToken(userId, null);
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async cleanExpiredTokens(): Promise<void> {
    this.logger.log('Ejecutando tarea de limpieza de tokens expirados...');
    const users = await this.userRepo.find({ where: { currentToken: Not(IsNull()) } });

    for (const user of users) {
      try {
        const decoded = this.jwtService.decode(user.currentToken) as { exp: number };
        if (!decoded || decoded.exp < Math.floor(Date.now() / 1000)) {
          this.logger.log(`Limpiando token expirado de ${user.username}`);
          await this.userService.updateCurrentToken(user.id, null);
        }
      } catch (err) {
        this.logger.warn(`Error decodificando token de ${user.username}, limpiando...`);
        await this.userService.updateCurrentToken(user.id, null);
      }
    }
  }
  async getProfile(userId: string): Promise<User> {
    const user = await this.userService.findById(userId);
    if (!user) {
      throw new UnauthorizedException();
    }
    delete user.password;
    return user;
  }
}