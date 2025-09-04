import { Module } from '@nestjs/common';
import { DashboardGateway } from './dashboard.gateway';

@Module({
  providers: [DashboardGateway],
  exports: [DashboardGateway], 
})
export class DashboardModule {}