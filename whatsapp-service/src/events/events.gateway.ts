import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';

// ✅ CAMBIO: Quitamos el número 3002.
// Al no poner puerto, usa el mismo servidor HTTP (puerto 3001) que ya configuramos en main.ts
@WebSocketGateway({
  cors: { 
    origin: '*',
    credentials: true 
  },
  path: '/socket.io/', 
  transports: ['websocket', 'polling'] 
})
export class EventsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(EventsGateway.name);

  handleConnection(client: Socket) {
    this.logger.log(`Cliente conectado al Socket (Puerto Compartido 3001): ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Cliente desconectado: ${client.id}`);
  }

  @SubscribeMessage('ping')
  handlePing(client: Socket): void {
    client.emit('pong', { message: 'PONG desde puerto 3001' });
  }
}