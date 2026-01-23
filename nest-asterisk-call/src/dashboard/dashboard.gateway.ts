import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';

interface ThrottleState {
  count: number;
  resetTime: number;
}

@WebSocketGateway({
  cors: {
    origin: '*', 
  },
})
export class DashboardGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(DashboardGateway.name);
  private readonly throttleMap = new Map<string, ThrottleState>();
  private readonly THROTTLE_LIMIT = 10;
  private readonly THROTTLE_WINDOW_MS = 1000;
  private readonly MAX_CONNECTIONS_PER_USER = 3;
  private readonly userConnections = new Map<string, Set<string>>();

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService
  ) {
    this.startThrottleCleanup();
  }

  private startThrottleCleanup(): void {
    setInterval(() => {
      const now = Date.now();
      for (const [key, state] of this.throttleMap.entries()) {
        if (now > state.resetTime) {
          this.throttleMap.delete(key);
        }
      }
    }, 30000);
  }

  async handleConnection(client: Socket, ...args: any[]) {
    const token = client.handshake.query.token as string || client.handshake.headers.authorization;
    
    if (token) {
      try {
        const cleanToken = token.replace('Bearer ', '');
        const payload = this.jwtService.verify(cleanToken, {
          secret: this.configService.get('JWT_SECRET')
        });
        
        const userId = payload.sub;
        
        if (!this.userConnections.has(userId)) {
          this.userConnections.set(userId, new Set());
        }
        
        const userSockets = this.userConnections.get(userId)!;
        
        if (userSockets.size >= this.MAX_CONNECTIONS_PER_USER) {
          this.logger.warn(`Usuario ${userId} excedió el límite de conexiones. Rechazando ${client.id}`);
          client.emit('error', { message: 'Límite de conexiones excedido' });
          client.disconnect(true);
          return;
        }
        
        userSockets.add(client.id);
        
        (client as any).userId = userId;
        (client as any).userRole = payload.role;
        
        client.join(userId);
        this.logger.log(`Cliente ${client.id} autenticado como usuario ${userId} (${userSockets.size}/${this.MAX_CONNECTIONS_PER_USER} conexiones)`);
        
        if (payload.role === 'ADMIN' || payload.role === 'SUPERVISOR') {
          client.join('ADMIN_ROOM');
          this.logger.log(`Cliente ${client.id} unido a ADMIN_ROOM`);
        }

      } catch (e) {
        this.logger.warn(`Cliente ${client.id} intentó conectar con token inválido: ${e.message}`);
        client.emit('error', { message: 'Token inválido' });
        client.disconnect(true);
      }
    } else {
      this.logger.warn(`Cliente ${client.id} intentó conectar sin token. Rechazando.`);
      client.emit('error', { message: 'Token requerido' });
      client.disconnect(true);
    }
  }

  handleDisconnect(client: any) {
    const userId = client.userId;
    
    if (userId) {
      const userSockets = this.userConnections.get(userId);
      if (userSockets) {
        userSockets.delete(client.id);
        if (userSockets.size === 0) {
          this.userConnections.delete(userId);
        }
        this.logger.log(`Cliente ${client.id} desconectado. Usuario ${userId} tiene ${userSockets.size} conexiones restantes`);
      }
    } else {
      this.logger.log(`Cliente desconectado del dashboard: ${client.id}`);
    }
  }

  private shouldThrottle(key: string): boolean {
    const now = Date.now();
    const state = this.throttleMap.get(key);

    if (!state || now > state.resetTime) {
      this.throttleMap.set(key, {
        count: 1,
        resetTime: now + this.THROTTLE_WINDOW_MS
      });
      return false;
    }

    if (state.count >= this.THROTTLE_LIMIT) {
      return true;
    }

    state.count++;
    return false;
  }

  sendUpdate(data: any, userId?: string) {
    const throttleKey = userId ? `user:${userId}` : 'global';
    
    if (this.shouldThrottle(throttleKey)) {
      return;
    }

    const sanitizedData = this.sanitizeData(data);

    if (userId) {
      const sent = this.server.to(userId).emit('dashboardUpdate', sanitizedData);
      
      this.server.to('ADMIN_ROOM').emit('dashboardUpdate', {
        ...sanitizedData,
        _targetUserId: userId
      });
    } else {
      this.server.to('ADMIN_ROOM').emit('dashboardUpdate', {
        ...sanitizedData,
        _broadcast: true
      });
    }
  }

  private sanitizeData(data: any): any {
    if (!data || typeof data !== 'object') {
      return data;
    }

    const sanitized = { ...data };
    
    const sensitiveFields = ['password', 'token', 'secret', 'apiKey', 'privateKey'];
    for (const field of sensitiveFields) {
      if (field in sanitized) {
        delete sanitized[field];
      }
    }

    if (sanitized.event && typeof sanitized.event === 'string') {
      sanitized.timestamp = Date.now();
    }

    return sanitized;
  }

  broadcastToAdmins(data: any) {
    if (this.shouldThrottle('admin_broadcast')) {
      return;
    }

    const sanitizedData = this.sanitizeData(data);
    this.server.to('ADMIN_ROOM').emit('adminUpdate', sanitizedData);
  }

  getConnectedUsersCount(): number {
    return this.userConnections.size;
  }

  getUserConnectionCount(userId: string): number {
    return this.userConnections.get(userId)?.size || 0;
  }

  disconnectUser(userId: string, reason: string = 'Desconectado por el sistema') {
    const userSockets = this.userConnections.get(userId);
    if (userSockets) {
      for (const socketId of userSockets) {
        const socket = this.server.sockets.sockets.get(socketId);
        if (socket) {
          socket.emit('forceDisconnect', { reason });
          socket.disconnect(true);
        }
      }
      this.userConnections.delete(userId);
      this.logger.log(`Usuario ${userId} desconectado forzosamente: ${reason}`);
    }
  }

  @SubscribeMessage('ping')
  handlePing(@ConnectedSocket() client: Socket): void {
    client.emit('pong', { timestamp: Date.now() });
  }

  @SubscribeMessage('subscribe')
  handleSubscribe(
    @ConnectedSocket() client: any,
    @MessageBody() data: { channel: string }
  ): void {
    const userId = client.userId;
    const role = client.userRole;

    if (!userId) {
      client.emit('error', { message: 'No autenticado' });
      return;
    }

    const allowedChannels = ['campaigns', 'calls', 'stats'];
    
    if (!allowedChannels.includes(data.channel)) {
      client.emit('error', { message: 'Canal no válido' });
      return;
    }

    const roomName = `${data.channel}:${userId}`;
    client.join(roomName);
    
    this.logger.log(`Cliente ${client.id} suscrito al canal ${roomName}`);
    client.emit('subscribed', { channel: data.channel, room: roomName });
  }

  @SubscribeMessage('unsubscribe')
  handleUnsubscribe(
    @ConnectedSocket() client: any,
    @MessageBody() data: { channel: string }
  ): void {
    const userId = client.userId;
    
    if (!userId) {
      return;
    }

    const roomName = `${data.channel}:${userId}`;
    client.leave(roomName);
    
    this.logger.log(`Cliente ${client.id} desuscrito del canal ${roomName}`);
    client.emit('unsubscribed', { channel: data.channel });
  }
}