/**import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserModule } from './user/user.module';
import { AuthModule } from './auth/auth.module';
import { CampaignModule } from './campaign/campaign.module';
import { AmiModule } from './ami/ami.module';
import { ScheduleModule } from '@nestjs/schedule';
import { DashboardModule } from './dashboard/dashboard.module';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { StatsModule } from './stats/stats.module';
import { WhatsappModule } from './whatsapp/whatsapp.module';
import { ChannelLimitModule } from './channel-limit/channel-limit.module';
import { AuditModule } from './audit/audit.module';
import { ContactosModule } from './contactos/contactos.module';
import { WhatsappCampaignModule } from './whatsapp-campaign/whatsapp-campaign.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        type: 'postgres',
        host: configService.get<string>('DB_HOST'),
        port: configService.get<number>('DB_PORT'),
        username: configService.get<string>('DB_USERNAME'),
        password: configService.get<string>('DB_PASSWORD'),
        database: configService.get<string>('DB_DATABASE'),
        entities: [__dirname + '/**/ /***.entity{.ts,.js}'],   
        synchronize: true,
      }),
      inject: [ConfigService],
    }),
    TypeOrmModule.forRootAsync({
      name: 'contactos',
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        type: 'postgres',
        host: configService.get<string>('DB_CONTACTOS_HOST'),
        port: configService.get<number>('DB_CONTACTOS_PORT'),
        username: configService.get<string>('DB_CONTACTOS_USERNAME'),
        password: configService.get<string>('DB_CONTACTOS_PASSWORD'),
        database: configService.get<string>('DB_CONTACTOS_DATABASE'),
        entities: [__dirname + '/../**//***.entity{.ts,.js}'],
        synchronize: false,
      }),
      inject: [ConfigService],
    }),
    ClientsModule.registerAsync([
      {
        name: 'WHATSAPP_SERVICE',
        imports: [ConfigModule],
        useFactory: (configService: ConfigService) => ({
          transport: Transport.REDIS,
          options: {
            host: configService.get<string>('REDIS_HOST'),
            port: configService.get<number>('REDIS_PORT'),
          },
        }),
        inject: [ConfigService],
      },
    ]),
    UserModule,
    AuthModule,
    CampaignModule,
    AmiModule,
    DashboardModule,
    StatsModule,
    WhatsappModule,
    ChannelLimitModule,
    AuditModule,
    ContactosModule,
    WhatsappCampaignModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {} **/

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
import { WhatsappModule } from './whatsapp/whatsapp.module';
import { AuditModule } from './audit/audit.module';
import { AuditSubscriber } from './audit/audit.subscriber';
import { RequestContext } from './core/request-context.service';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { RequestContextInterceptor } from './core/request-context.interceptor';
import { WhatsappCampaignModule } from './whatsapp-campaign/whatsapp-campaign.module';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { DashboardModule } from './dashboard/dashboard.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }), 
    AmiModule,
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
    WhatsappModule,
    AuditModule,
    WhatsappCampaignModule,
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
export class AppModule {}
