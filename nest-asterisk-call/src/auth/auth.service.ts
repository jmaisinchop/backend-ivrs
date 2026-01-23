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
  private readonly activeTokens = new Map<string, { userId: string; expiresAt: number }>();

  constructor(
    private userService: UserService,
    private jwtService: JwtService,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {
    this.startTokenCleanup();
  }

  private startTokenCleanup(): void {
    setInterval(() => {
      const now = Date.now();
      for (const [token, data] of this.activeTokens.entries()) {
        if (now > data.expiresAt) {
          this.activeTokens.delete(token);
        }
      }
    }, 300000);
  }

  async validateUser(username: string, pass: string): Promise<any> {
    if (!username || !pass) {
      throw new UnauthorizedException('Credenciales incompletas');
    }

    if (username.length > 100 || pass.length > 200) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    const user = await this.userService.findByUsername(username);
    
    if (!user) {
      await this.simulatePasswordCheck();
      throw new UnauthorizedException('Credenciales inválidas');
    }

    const isValid = await bcrypt.compare(pass, user.password);
    
    if (!isValid) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    const { password, ...result } = user;
    return result;
  }

  private async simulatePasswordCheck(): Promise<void> {
    await bcrypt.hash('dummy', 10);
  }

  async login(user: any) {
    const dbUser = await this.userService.findById(user.id);
    
    if (!dbUser) {
      throw new UnauthorizedException('Usuario no encontrado');
    }

    if (dbUser?.currentToken) {
      const isTokenValid = this.activeTokens.has(dbUser.currentToken);
      
      if (isTokenValid) {
        throw new UnauthorizedException(
          'Ya tienes una sesión activa. Cierra sesión desde el otro dispositivo antes de continuar.',
        );
      } else {
        await this.userService.updateCurrentToken(user.id, null);
      }
    }

    const payload = { 
      username: user.username, 
      sub: user.id, 
      role: user.role,
      iat: Math.floor(Date.now() / 1000)
    };
    
    const token = this.jwtService.sign(payload);
    
    const decoded = this.jwtService.decode(token) as { exp: number };
    this.activeTokens.set(token, {
      userId: user.id,
      expiresAt: decoded.exp * 1000
    });

    await this.userService.updateCurrentToken(user.id, token);

    return {
      access_token: token,
      user: {
        id: dbUser.id,
        username: dbUser.username,
        email: dbUser.email,
        firstName: dbUser.firstName,
        lastName: dbUser.lastName,
        role: dbUser.role,
        canAccessIvrs: dbUser.canAccessIvrs,
        extension: dbUser.extension
      },
    };
  }

  async logout(userId: string) {
    const user = await this.userService.findById(userId);
    
    if (user?.currentToken) {
      this.activeTokens.delete(user.currentToken);
    }
    
    await this.userService.updateCurrentToken(userId, null);
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async cleanExpiredTokens(): Promise<void> {
    this.logger.log('Ejecutando tarea de limpieza de tokens expirados...');
    
    const users = await this.userRepo.find({ 
      where: { currentToken: Not(IsNull()) },
      select: ['id', 'username', 'currentToken']
    });

    let cleanedCount = 0;

    for (const user of users) {
      try {
        const decoded = this.jwtService.decode(user.currentToken) as { exp: number };
        
        if (!decoded || decoded.exp < Math.floor(Date.now() / 1000)) {
          this.logger.log(`Limpiando token expirado de ${user.username}`);
          this.activeTokens.delete(user.currentToken);
          await this.userService.updateCurrentToken(user.id, null);
          cleanedCount++;
        }
      } catch (err) {
        this.logger.warn(`Error decodificando token de ${user.username}, limpiando...`);
        this.activeTokens.delete(user.currentToken);
        await this.userService.updateCurrentToken(user.id, null);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      this.logger.log(`Limpiados ${cleanedCount} tokens expirados`);
    }
  }

  async getProfile(userId: string): Promise<User> {
    const user = await this.userService.findById(userId);
    
    if (!user) {
      throw new UnauthorizedException('Usuario no encontrado');
    }
    
    delete user.password;
    delete user.currentToken;
    
    return user;
  }

  isTokenActive(token: string): boolean {
    const tokenData = this.activeTokens.get(token);
    
    if (!tokenData) {
      return false;
    }

    if (Date.now() > tokenData.expiresAt) {
      this.activeTokens.delete(token);
      return false;
    }

    return true;
  }

  async invalidateUserSessions(userId: string): Promise<void> {
    const user = await this.userService.findById(userId);
    
    if (user?.currentToken) {
      this.activeTokens.delete(user.currentToken);
      await this.userService.updateCurrentToken(userId, null);
      this.logger.log(`Sesiones invalidadas para usuario ${userId}`);
    }
  }

  getActiveSessionsCount(): number {
    return this.activeTokens.size;
  }
}