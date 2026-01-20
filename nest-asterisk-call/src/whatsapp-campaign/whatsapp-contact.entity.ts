import { Entity, PrimaryGeneratedColumn, Column, ManyToOne } from 'typeorm';
import { WhatsappCampaign } from './whatsapp-campaign.entity';

@Entity()
export class WhatsappContact {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ nullable: true })
    identification: string;

    @Column()
    name: string;
    
    @Column()
    phone: string;

    @Column({ type: 'text' })
    message: string;

    // Estados: PENDING, SENDING, SENT, DELIVERED, READ, FAILED
    @Column({ default: 'PENDING' })
    status: string;
    
    @Column({ nullable: true })
    errorMessage: string;

    @ManyToOne(() => WhatsappCampaign, campaign => campaign.contacts, { onDelete: 'CASCADE' })
    campaign: WhatsappCampaign;
}