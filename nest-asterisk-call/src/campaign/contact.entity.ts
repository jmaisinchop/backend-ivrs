import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, Index, Generated } from 'typeorm';
import { Campaign } from './campaign.entity';

@Entity()
export class Contact {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // Nuevo campo para identificación
  @Column({
    type: 'varchar',
    length: 18,
    default: "''",    // default cadena vacía
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

  // NOT_CALLED, CALLING, SUCCESS, FAILED...
  @Column({ default: 'NOT_CALLED' })
  callStatus: string;

  // Guardar código y texto de causa
  @Column({ nullable: true })
  hangupCode: string; // p.ej. "17"

  @Column({ nullable: true })
  hangupCause: string; // p.ej. "User busy"

  @Index()
  @Column({ type: 'bigint' })
  @Generated('increment')
  sequence: number;

  @ManyToOne(() => Campaign, (campaign) => campaign.contacts, {
    onDelete: 'CASCADE',
  })
  campaign: Campaign;

// Nuevos Timestamps
@Column({ type: 'timestamp', nullable: true, comment: 'Timestamp when the call process started for this contact' })
startedAt: Date | null;

@Column({ type: 'timestamp', nullable: true, comment: 'Timestamp when the call was answered' })
answeredAt: Date | null;

@Column({ type: 'timestamp', nullable: true, comment: 'Timestamp when the call process finished for this contact' })
finishedAt: Date | null;
}
