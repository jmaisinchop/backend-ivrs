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
import { Logger, UseGuards } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';

@WebSocketGateway({
  cors: {
    origin: '*', 
  },
})
export class DashboardGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(DashboardGateway.name);

  constructor(
      private readonly jwtService: JwtService,
      private readonly configService: ConfigService
  ) {}

  async handleConnection(client: Socket, ...args: any[]) {
    // Autenticación básica por token en query param o header si es necesario
    const token = client.handshake.query.token as string || client.handshake.headers.authorization;
    
    if (token) {
        try {
            // Limpiar 'Bearer ' si viene en el header
            const cleanToken = token.replace('Bearer ', '');
            const payload = this.jwtService.verify(cleanToken, {
                secret: this.configService.get('JWT_SECRET')
            });
            
            // Unir al usuario a su sala privada (Room = UserID)
            const userId = payload.sub; // Asumiendo que 'sub' es el ID del usuario
            client.join(userId);
            this.logger.log(`Cliente ${client.id} autenticado y unido a sala ${userId}`);
            
            // También unirse a sala global si es admin (opcional)
            if (payload.role === 'ADMIN' || payload.role === 'SUPERVISOR') {
                client.join('ADMIN_ROOM');
            }

        } catch (e) {
            this.logger.warn(`Cliente ${client.id} intentó conectar con token inválido.`);
            // No desconectamos forzosamente para no romper clientes simples, pero no lo unimos a salas.
        }
    } else {
        this.logger.log(`Cliente conectado sin token al dashboard: ${client.id}`);
    }
  }

  handleDisconnect(client: any) {
    this.logger.log(`Cliente desconectado del dashboard: ${client.id}`);
  }

  /**
   * Envía una actualización al dashboard.
   * AHORA ES INTELIGENTE: Si se pasa un userId, solo notifica a ese usuario.
   */
  sendUpdate(data: any, userId?: string) {
    if (userId) {
        // Enviar solo al usuario específico
        this.server.to(userId).emit('dashboardUpdate', data);
        // Y también a los administradores/supervisores
        this.server.to('ADMIN_ROOM').emit('dashboardUpdate', data);
    } else {
        // Comportamiento antiguo (Broadcast a todos) - Usar con precaución
        // Útil para métricas globales del sistema
        this.server.emit('dashboardUpdate', data);
    }
  }
}