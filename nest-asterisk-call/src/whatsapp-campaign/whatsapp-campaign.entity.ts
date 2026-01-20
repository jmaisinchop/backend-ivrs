import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, OneToMany, ManyToOne } from 'typeorm';
import { WhatsappContact } from './whatsapp-contact.entity';
import { User } from '../user/user.entity';

@Entity()
export class WhatsappCampaign {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    name: string;

    @Column({ type: 'text', nullable: true })
    messageBody: string;
    @Column({ type: 'timestamp', comment: 'Fecha programada para el envío' })
    sendDate: Date;
    

    @Column({ default: 'PAUSED' })
    status: string;

    @Column({ type: 'timestamp', nullable: true, comment: 'Fecha y hora real en que se inició la campaña' })
    startedAt: Date | null;

    @Column({ type: 'timestamp', nullable: true, comment: 'Fecha y hora en que se completó o canceló' })
    finishedAt: Date | null;

    @CreateDateColumn()
    createdAt: Date;

    @OneToMany(() => WhatsappContact, contact => contact.campaign, { cascade: true })
    contacts: WhatsappContact[];

    @ManyToOne(() => User, { eager: true })
    createdBy: User;
}