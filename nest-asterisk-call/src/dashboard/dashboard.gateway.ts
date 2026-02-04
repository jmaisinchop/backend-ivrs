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
import { Logger, Inject, forwardRef } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AgentService } from '../post-call/agent.service';

interface ThrottleState {
  count: number;
  resetTime: number;
}

@WebSocketGateway({ cors: { origin: '*' } })
export class DashboardGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(DashboardGateway.name);
  private readonly throttleMap = new Map<string, ThrottleState>();
  private readonly THROTTLE_LIMIT = 20;
  private readonly THROTTLE_WINDOW_MS = 1000;
  private readonly MAX_CONNECTIONS_PER_USER = 5;

  // userId → Set de socket IDs conectados
  private readonly userConnections = new Map<string, Set<string>>();
  // socketId → { userId, userRole } para recuperar datos en disconnect
  private readonly socketMeta = new Map<string, { userId: string; userRole: string }>();

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    @Inject(forwardRef(() => AgentService))
    private readonly agentService: AgentService,
  ) {
    this.startThrottleCleanup();
  }

  private startThrottleCleanup(): void {
    setInterval(() => {
      const now = Date.now();
      for (const [key, state] of this.throttleMap.entries()) {
        if (now > state.resetTime) this.throttleMap.delete(key);
      }
    }, 30000);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CONEXIÓN
  // ═══════════════════════════════════════════════════════════════════════════

  async handleConnection(client: Socket) {
    const token =
      (client.handshake.query.token as string) ||
      (client.handshake.headers.authorization as string);

    if (!token) {
      this.logger.warn(`[GW] Socket ${client.id} sin token — rechazando`);
      client.emit('error', { message: 'Token requerido' });
      client.disconnect(true);
      return;
    }

    try {
      const cleanToken = token.replace('Bearer ', '');
      const payload = this.jwtService.verify(cleanToken, {
        secret: this.configService.get('JWT_SECRET'),
      });

      const userId  = payload.sub;
      const userRole = payload.role;

      // ─── Límite de sockets por usuario ───────────────────────────────────
      if (!this.userConnections.has(userId)) {
        this.userConnections.set(userId, new Set());
      }
      const userSockets = this.userConnections.get(userId)!;

      if (userSockets.size >= this.MAX_CONNECTIONS_PER_USER) {
        this.logger.warn(`[GW] Usuario ${userId} excedió límite de ${this.MAX_CONNECTIONS_PER_USER} sockets`);
        client.emit('error', { message: 'Límite de conexiones excedido' });
        client.disconnect(true);
        return;
      }

      // ─── Registrar socket ─────────────────────────────────────────────────
      userSockets.add(client.id);
      this.socketMeta.set(client.id, { userId, userRole });

      this.logger.log(
        `[GW] ✅ Socket ${client.id} conectado → Usuario ${userId} (${userRole}) — ` +
        `${userSockets.size}/${this.MAX_CONNECTIONS_PER_USER} sockets activos`
      );

      // ─── Rooms ───────────────────────────────────────────────────────────
      client.join(userId); // room personal del usuario

      if (userRole === 'ADMIN' || userRole === 'SUPERVISOR') {
        client.join('ADMIN_ROOM');
      }

      // ─── Si es CALLCENTER → notificar al AgentService ───────────────────
      if (userRole === 'CALLCENTER') {
        this.logger.log(`[GW] 🟢 Asesor ${userId} conectó — notificando AgentService`);
        this.agentService.onAgentConnected(userId);
      }

    } catch (e) {
      this.logger.warn(`[GW] Socket ${client.id} token inválido: ${e.message}`);
      client.emit('error', { message: 'Token inválido' });
      client.disconnect(true);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DESCONEXIÓN
  // ═══════════════════════════════════════════════════════════════════════════

  handleDisconnect(client: Socket) {
    const meta = this.socketMeta.get(client.id);
    
    if (!meta) {
      this.logger.log(`[GW] ⚠️ Socket ${client.id} desconectó sin metadata (posible token inválido)`);
      return;
    }

    const { userId, userRole } = meta;
    
    // Limpiar socketMeta inmediatamente
    this.socketMeta.delete(client.id);

    this.logger.log(`[GW] 🔴 Socket ${client.id} desconectó → Usuario ${userId} (${userRole})`);

    const userSockets = this.userConnections.get(userId);
    if (!userSockets) {
      this.logger.warn(`[GW] ⚠️ Usuario ${userId} no tenía entry en userConnections`);
      return;
    }

    // Remover este socket del set
    userSockets.delete(client.id);

    if (userSockets.size === 0) {
      // El usuario no tiene más sockets activos
      this.userConnections.delete(userId);

      this.logger.log(`[GW] 📴 Usuario ${userId} sin sockets activos`);

      // ─── Si era CALLCENTER → notificar al AgentService ──────────────
      if (userRole === 'CALLCENTER') {
        this.logger.log(`[GW] 🔴 Asesor ${userId} perdió todos sus sockets → notificando AgentService (OFFLINE)`);
        this.agentService.onAgentDisconnected(userId);
      }
    } else {
      this.logger.log(
        `[GW] Usuario ${userId} todavía tiene ${userSockets.size} socket(s) activo(s) — ` +
        `NO se notifica desconexión`
      );
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ENVÍO DE MENSAJES
  // ═══════════════════════════════════════════════════════════════════════════

  private shouldThrottle(key: string): boolean {
    const now = Date.now();
    const state = this.throttleMap.get(key);
    if (!state || now > state.resetTime) {
      this.throttleMap.set(key, { count: 1, resetTime: now + this.THROTTLE_WINDOW_MS });
      return false;
    }
    if (state.count >= this.THROTTLE_LIMIT) return true;
    state.count++;
    return false;
  }

  sendUpdate(data: any, userId?: string): void {
    const throttleKey = userId ? `user:${userId}` : 'global';
    if (this.shouldThrottle(throttleKey)) return;

    const sanitized = this.sanitizeData(data);
    const eventName = sanitized.event || 'dashboardUpdate';

    if (userId) {
      this.server.to(userId).emit(eventName, sanitized);
    } else {
      this.server.to('ADMIN_ROOM').emit('dashboardUpdate', { ...sanitized, _broadcast: true });
    }
  }

  broadcastToAdmins(data: any): void {
    if (this.shouldThrottle('admin_broadcast')) return;
    const sanitized = this.sanitizeData(data);
    const eventName = sanitized.event || 'adminUpdate';
    this.server.to('ADMIN_ROOM').emit(eventName, sanitized);
  }

  private sanitizeData(data: any): any {
    if (!data || typeof data !== 'object') return data;
    const sanitized = { ...data };
    for (const field of ['password', 'token', 'secret', 'apiKey', 'privateKey']) {
      if (field in sanitized) delete sanitized[field];
    }
    if (sanitized.event) sanitized.timestamp = Date.now();
    return sanitized;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // UTILIDADES
  // ═══════════════════════════════════════════════════════════════════════════

  getConnectedUsersCount(): number {
    return this.userConnections.size;
  }

  getUserConnectionCount(userId: string): number {
    return this.userConnections.get(userId)?.size || 0;
  }

  disconnectUser(userId: string, reason: string = 'Desconectado por el sistema'): void {
    const userSockets = this.userConnections.get(userId);
    if (!userSockets) return;
    for (const socketId of userSockets) {
      const socket = this.server.sockets.sockets.get(socketId);
      if (socket) {
        socket.emit('forceDisconnect', { reason });
        socket.disconnect(true);
      }
    }
    this.userConnections.delete(userId);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SUBSCRIBE HANDLERS
  // ═══════════════════════════════════════════════════════════════════════════

  @SubscribeMessage('ping')
  handlePing(@ConnectedSocket() client: Socket): void {
    client.emit('pong', { timestamp: Date.now() });
  }

  @SubscribeMessage('subscribe')
  handleSubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { channel: string },
  ): void {
    const meta = this.socketMeta.get(client.id);
    if (!meta) { client.emit('error', { message: 'No autenticado' }); return; }

    const allowed = ['campaigns', 'calls', 'stats'];
    if (!allowed.includes(data.channel)) {
      client.emit('error', { message: 'Canal no válido' });
      return;
    }
    const room = `${data.channel}:${meta.userId}`;
    client.join(room);
    client.emit('subscribed', { channel: data.channel, room });
  }

  @SubscribeMessage('unsubscribe')
  handleUnsubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { channel: string },
  ): void {
    const meta = this.socketMeta.get(client.id);
    if (!meta) return;
    client.leave(`${data.channel}:${meta.userId}`);
    client.emit('unsubscribed', { channel: data.channel });
  }
}