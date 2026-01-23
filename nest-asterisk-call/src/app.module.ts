import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AmiModule } from './ami/ami.module';
import { HttpModule } from '@nestjs/axios';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { CampaignModule } from './campaign/campaign.module';
import { UserModule } from './user/user.module';
import { AuthModule } from './auth/auth.module';
import { ChannelLimitModule } from './channel-limit/channel-limit.module';
import { StatsModule } from './stats/stats.module';
import { ContactosModule } from './contactos/contactos.module';
import { AuditModule } from './audit/audit.module';
import { AuditSubscriber } from './audit/audit.subscriber';
import { RequestContext } from './core/request-context.service';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { RequestContextInterceptor } from './core/request-context.interceptor';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { DashboardModule } from './dashboard/dashboard.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      ignoreEnvFile: process.env.NODE_ENV === 'production',
      envFilePath: '.env.dev',
    }), AmiModule,
    HttpModule,
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        type: 'postgres',
        host: configService.get<string>('DB_HOST'),
        port: configService.get<number>('DB_PORT'),
        username: configService.get<string>('DB_USERNAME'),
        password: configService.get<string>('DB_PASSWORD'),
        database: configService.get<string>('DB_DATABASE'),
        autoLoadEntities: true,
        synchronize: true,
      }),
    }),
    TypeOrmModule.forRootAsync({
      name: 'contactos',
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        type: 'postgres',
        host: configService.get<string>('DB_CONTACTOS_HOST'),
        port: configService.get<number>('DB_CONTACTOS_PORT'),
        username: configService.get<string>('DB_CONTACTOS_USERNAME'),
        password: configService.get<string>('DB_CONTACTOS_PASSWORD'),
        database: configService.get<string>('DB_CONTACTOS_DATABASE'),
      }),
    }),
    ScheduleModule.forRoot(),
    CampaignModule,
    UserModule,
    AuthModule,
    ChannelLimitModule,
    StatsModule,
    ContactosModule,
    AuditModule,
    DashboardModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    AuditSubscriber,
    RequestContext,
    {
      provide: APP_INTERCEPTOR,
      useClass: RequestContextInterceptor,
    },
  ],
})
export class AppModule { }
