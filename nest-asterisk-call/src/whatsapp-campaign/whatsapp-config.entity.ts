import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity()
export class WhatsappConfig {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    // Rango horario para CREAR campañas (ej. los usuarios solo pueden subir Excels de 8am a 10am)
    @Column({ default: '08:00' })
    creationStartTime: string;

    @Column({ default: '18:00' })
    creationEndTime: string;

    // Rango horario para el MOTOR DE ENVÍO (a qué hora salen los mensajes)
    @Column({ default: '08:00' })
    sendingStartTime: string;

    @Column({ default: '20:00' })
    sendingEndTime: string;

    // Límites para usuarios
    @Column({ default: 2 })
    maxCampaignsPerUserPerDay: number;

    @Column({ default: 500 })
    maxContactsPerUserPerDay: number;

    // ANTI-BAN: Tiempos de espera (en segundos)
    @Column({ default: 30 })
    minDelaySeconds: number; // Mínimo esperar X seg entre mensajes

    @Column({ default: 60 })
    maxDelaySeconds: number; // Máximo esperar Y seg entre mensajes
}