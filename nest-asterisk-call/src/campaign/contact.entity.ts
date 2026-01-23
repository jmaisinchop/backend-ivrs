import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, Index, Generated } from 'typeorm';
import { Campaign } from './campaign.entity';

@Entity()
@Index(['campaign', 'callStatus'])
@Index(['campaign', 'callStatus', 'attemptCount'])
@Index(['campaign', 'attemptCount'])
@Index(['activeChannelId'], { where: '"activeChannelId" IS NOT NULL' })
@Index(['finishedAt'], { where: '"callStatus" = \'FAILED\'' })
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

  @Column({ type: 'text' })
  message: string;

  @Column({ default: 0 })
  attemptCount: number;

  @Index()
  @Column({ default: 'NOT_CALLED' })
  callStatus: string;

  @Column({ nullable: true })
  hangupCode: string; 
  
  @Column({ nullable: true })
  hangupCause: string; 

  @Index()
  @Column({ type: 'bigint' })
  @Generated('increment')
  sequence: number;
  
  @Column({ type: 'varchar', length: 100, nullable: true }) 
  activeChannelId: string | null;

  @ManyToOne(() => Campaign, (campaign) => campaign.contacts, {
    onDelete: 'CASCADE',
  })
  campaign: Campaign;

  @Index()
  @Column({ type: 'timestamp', nullable: true, comment: 'Timestamp when the call process started for this contact' })
  startedAt: Date | null;

  @Column({ type: 'timestamp', nullable: true, comment: 'Timestamp when the call was answered' })
  answeredAt: Date | null;

  @Index()
  @Column({ type: 'timestamp', nullable: true, comment: 'Timestamp when the call process finished for this contact' })
  finishedAt: Date | null;
}