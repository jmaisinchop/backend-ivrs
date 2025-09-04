import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';

@WebSocketGateway({
  cors: { origin: '*' }, // Permite conexiones desde cualquier origen
})
export class EventsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(EventsGateway.name);

  handleConnection(client: Socket) {
    this.logger.log(`Cliente de Frontend conectado: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Cliente de Frontend desconectado: ${client.id}`);
  }
   // ✅ AÑADIMOS ESTA FUNCIÓN PARA LA PRUEBA
  @SubscribeMessage('ping')
  handlePing(client: Socket): void {
    this.logger.log(`PING recibido del cliente ${client.id}. Enviando PONG...`);
    // Respondemos inmediatamente con un evento 'pong'
    client.emit('pong', { message: 'Respuesta del servidor' });
  }
}