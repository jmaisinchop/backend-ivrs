import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, CreateDateColumn, Index } from 'typeorm';
import { Contact } from '../campaign/contact.entity';
import { User } from '../user/user.entity';

export enum CommitmentSource {
  AUTOMATIC = 'AUTOMATIC',   // El cliente lo registró por DTMF en el menú
  MANUAL = 'MANUAL',         // El asesor lo registró desde su panel
}

@Entity('commitment')
export class Commitment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // Contacto al que pertenece el compromiso (tiene la cédula)
  @ManyToOne(() => Contact, { onDelete: 'CASCADE' })
  contact: Contact;

  // Fecha que el cliente prometió pagar (solo día + mes actual al momento de captura)
  @Index()
  @Column({ type: 'date' })
  commitmentDate: Date;

  // Si fue capturado por DTMF automático o registrado por el asesor
  @Column({ type: 'enum', enum: CommitmentSource })
  source: CommitmentSource;

  // Asesor que atendió la llamada (null si fue solo automático sin transferencia)
  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  attendedBy: User | null;

  // Nota libre que el asesor puede agregar
  @Column({ type: 'text', nullable: true })
  note: string | null;

  // Campaña de origen (redundante pero útil para reportes directos sin joins)
  @Column({ type: 'varchar', nullable: true })
  campaignId: string | null;

  @CreateDateColumn()
  createdAt: Date;
}