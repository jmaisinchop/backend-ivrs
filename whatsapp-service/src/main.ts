import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { ConfigService } from '@nestjs/config'; // Importar ConfigService

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService); // Obtener instancia

  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.REDIS,
    options: {
      host: configService.get<string>('REDIS_HOST'),
      port: configService.get<number>('REDIS_PORT'),
    },
  });

  await app.startAllMicroservices();
  
  const port = configService.get<number>('PORT') || 3001;
  await app.listen(port);
  console.log(`✅ WhatsApp Microservice está corriendo y escuchando WebSockets en el puerto ${port}`);
}
bootstrap();