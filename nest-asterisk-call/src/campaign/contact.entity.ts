import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, Index, Generated } from 'typeorm';
import { Campaign } from './campaign.entity';

@Entity()
// ÍNDICES CRÍTICOS PARA EL RENDIMIENTO
@Index(['campaign', 'callStatus']) // Para contar estados rápidamente
@Index(['campaign', 'callStatus', 'attemptCount']) // Para processCampaign (saber a quién llamar)
@Index(['callStatus']) // Para métricas globales
export class Contact {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({
    type: 'varchar',
    length: 18,
    default: "''",   
  })
  identification: string;

  @Column()
  name: string;

  @Column({ default: '' })
  phone: string;

  @Column()
  message: string;

  @Column({ default: 0 })
  attemptCount: number;

  @Column({ default: 'NOT_CALLED' })
  callStatus: string;

  @Column({ nullable: true })
  hangupCode: string; 
  
  @Column({ nullable: true })
  hangupCause: string; 

  @Index() // Índice simple para ordenamiento
  @Column({ type: 'bigint' })
  @Generated('increment')
  sequence: number;
  
  @Column({ type: 'varchar', length: 100, nullable: true }) 
  activeChannelId: string | null;

  @ManyToOne(() => Campaign, (campaign) => campaign.contacts, {
    onDelete: 'CASCADE',
  })
  campaign: Campaign;

  @Column({ type: 'timestamp', nullable: true, comment: 'Timestamp when the call process started for this contact' })
  startedAt: Date | null;

  @Column({ type: 'timestamp', nullable: true, comment: 'Timestamp when the call was answered' })
  answeredAt: Date | null;

  @Column({ type: 'timestamp', nullable: true, comment: 'Timestamp when the call process finished for this contact' })
  finishedAt: Date | null;
}