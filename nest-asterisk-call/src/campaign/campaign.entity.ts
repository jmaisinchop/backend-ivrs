import { Entity, PrimaryGeneratedColumn, Column, OneToMany, Index } from 'typeorm';
import { Contact } from './contact.entity';

@Entity()
export class Campaign {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Index()
  @Column({ type: 'timestamp without time zone' })
  startDate: Date;

  @Column({ type: 'timestamp without time zone' })
  endDate: Date;

  @Column({ default: 3 })
  maxRetries: number;

  @Column({ default: 2 })
  concurrentCalls: number;

  @Index() 
  @Column({ default: 'SCHEDULED' })
  status: string;

  @Column({ default: false, comment: 'Reintentar inmediatamente si la causa es No Contesto' })
  retryOnAnswer: boolean;
  
  @OneToMany(() => Contact, (contact) => contact.campaign)
  contacts: Contact[];

  @Index() // Para filtrar campañas por usuario (Dashboard CallCenter)
  @Column({ nullable: true })
  createdBy: string;
}