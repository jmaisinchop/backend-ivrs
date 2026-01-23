import { Module } from '@nestjs/common';
import { DashboardGateway } from './dashboard.gateway';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule } from '@nestjs/config';

@Module({
  imports: [
    JwtModule.register({}),
    ConfigModule,
  ],
  providers: [DashboardGateway],
  exports: [DashboardGateway], 
})
export class DashboardModule {}