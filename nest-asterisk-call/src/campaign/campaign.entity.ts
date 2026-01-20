import { Entity, PrimaryGeneratedColumn, Column, OneToMany } from 'typeorm';
import { Contact } from './contact.entity';

@Entity()
export class Campaign {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column({ type: 'timestamp without time zone' })
  startDate: Date;

  @Column({ type: 'timestamp without time zone' })
  endDate: Date;

  @Column({ default: 3 })
  maxRetries: number;

  @Column({ default: 2 })
  concurrentCalls: number;

  // SCHEDULED, RUNNING, PAUSED, CANCELLED, COMPLETED
  @Column({ default: 'SCHEDULED' })
  status: string;

  @Column({ default: false, comment: 'Reintentar inmediatamente si la causa es No Contesto' })
  retryOnAnswer: boolean;
  
  @OneToMany(() => Contact, (contact) => contact.campaign)
  contacts: Contact[];

  @Column({ nullable: true })
  createdBy: string;
  
}
