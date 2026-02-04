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
import { APP_INTERCEPTOR, APP_GUARD } from '@nestjs/core';
import { RequestContextInterceptor } from './core/request-context.interceptor';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { DashboardModule } from './dashboard/dashboard.module';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { PostCallModule } from './post-call/post-call.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      ignoreEnvFile: process.env.NODE_ENV === 'production',
      envFilePath: '.env.dev',
      cache: true,
    }),
    ThrottlerModule.forRoot([{
      ttl: 60000,
      limit: 100,
    }]),
    HttpModule.register({
      timeout: 30000,
      maxRedirects: 3,
    }),
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
        timezone: 'America/Guayaquil',
        synchronize: configService.get<string>('NODE_ENV') !== 'production',
        logging: configService.get<string>('NODE_ENV') === 'development' ? ['error', 'warn'] : false,
        maxQueryExecutionTime: 5000,
        extra: {
          max: 20,
          min: 5,
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 10000,
          statement_timeout: 30000,
          query_timeout: 30000,
        },
        poolSize: 20,
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
        logging: false,
        extra: {
          max: 10,
          min: 2,
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 10000,
          statement_timeout: 30000,
          query_timeout: 30000,
        },
        poolSize: 10,
      }),
    }),
    ScheduleModule.forRoot(),
    AmiModule,
    CampaignModule,
    UserModule,
    AuthModule,
    ChannelLimitModule,
    StatsModule,
    ContactosModule,
    AuditModule,
    DashboardModule,
    PostCallModule,
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
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule { }