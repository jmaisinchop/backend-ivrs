import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditLog } from './audit.entity';

@Module({
  imports: [TypeOrmModule.forFeature([AuditLog])],
  providers: [],
  exports: [],
})
export class AuditModule {}