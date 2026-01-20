import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Transport } from '@nestjs/microservices';
import { ConfigService } from '@nestjs/config';

async function bootstrap() {
  process.env.TZ = 'America/Guayaquil';

  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService);

  // 1. IMPORTANTE: Habilitar CORS
  // Sin esto, el frontend dará error al intentar conectar los sockets
  app.enableCors({
    origin: '*', 
    credentials: true,
  });

  app.connectMicroservice({
    transport: Transport.REDIS,
    options: {
      host: configService.get<string>('REDIS_HOST'),
      port: configService.get<number>('REDIS_PORT'),
    },
  });

  await app.startAllMicroservices();

  // 2. EL FIX DEFINITIVO: '0.0.0.0'
  // El segundo argumento '0.0.0.0' le dice a Nest: 
  // "Acepta conexiones desde cualquier lugar, incluyendo Nginx"
  const port = configService.get<number>('PORT') || 3001;
  await app.listen(port, '0.0.0.0');
  
  console.log(`Whatsapp Service escuchando en puerto ${port} host 0.0.0.0`);
}
bootstrap();