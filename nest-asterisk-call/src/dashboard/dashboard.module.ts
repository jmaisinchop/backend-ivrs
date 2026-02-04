import { Module, forwardRef } from '@nestjs/common';
import { DashboardGateway } from './dashboard.gateway';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PostCallModule } from '../post-call/post-call.module';

@Module({
  imports: [
    // JWT necesita ConfigService para leer JWT_SECRET del .env
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get('JWT_SECRET'),
        signOptions: { expiresIn: '7d' },
      }),
    }),
    
    ConfigModule,
    
    // PostCallModule exporta AgentService que DashboardGateway necesita
    // forwardRef resuelve la dependencia circular
    forwardRef(() => PostCallModule),
  ],
  providers: [DashboardGateway],
  exports: [DashboardGateway],
})
export class DashboardModule {}