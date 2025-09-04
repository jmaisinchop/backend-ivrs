import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server } from 'socket.io';
import { Logger } from '@nestjs/common';

@WebSocketGateway({
  cors: {
    origin: '*', // En producción, deberías restringir esto a tu dominio del frontend
  },
})
export class DashboardGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(DashboardGateway.name);

  handleConnection(client: any, ...args: any[]) {
    this.logger.log(`Cliente conectado al dashboard: ${client.id}`);
  }

  handleDisconnect(client: any) {
    this.logger.log(`Cliente desconectado del dashboard: ${client.id}`);
  }

  // Este método será llamado desde otros servicios para emitir actualizaciones
  sendUpdate(data: any) {
    this.server.emit('dashboardUpdate', data);
  }
}