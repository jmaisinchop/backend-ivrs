import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, CreateDateColumn, Index } from 'typeorm';
import { Contact } from '../campaign/contact.entity';
import { User } from '../user/user.entity';

export enum AgentCallEventType {
  QUEUED = 'QUEUED',                 // Cliente entró a la cola de espera
  QUEUE_POSITION_UPDATED = 'QUEUE_POSITION_UPDATED', // Su posición en cola cambió
  ASSIGNED = 'ASSIGNED',             // Se le asignó un asesor
  CONNECTED = 'CONNECTED',           // Bridge activo, asesor y cliente hablan
  FINISHED = 'FINISHED',             // Llamada terminó (cualquiera colgó)
  CLIENT_ABANDONED = 'CLIENT_ABANDONED', // Cliente colgó mientras estaba en cola
  TIMEOUT = 'TIMEOUT',               // Cliente no marcó ninguna tecla en el menú
}

@Entity('agent_call_event')
export class AgentCallEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // Contacto involucrado
  @ManyToOne(() => Contact, { onDelete: 'CASCADE' })
  contact: Contact;

  // Asesor involucrado (null si el cliente colgó en cola antes de ser asignado)
  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  agent: User | null;

  // Tipo de evento
  @Index()
  @Column({ type: 'enum', enum: AgentCallEventType })
  eventType: AgentCallEventType;

  // Campaña de origen
  @Index()
  @Column({ type: 'varchar', nullable: true })
  campaignId: string | null;

  // Posición en cola al momento del evento (solo aplica a QUEUED y QUEUE_POSITION_UPDATED)
  @Column({ type: 'int', nullable: true })
  queuePosition: number | null;

  // Duración en segundos (solo aplica a FINISHED: tiempo total que duró la llamada con el asesor)
  @Column({ type: 'int', nullable: true })
  durationSeconds: number | null;

  // Tiempo que el cliente esperó en cola antes de ser conectado (segundos, solo CONNECTED)
  @Column({ type: 'int', nullable: true })
  waitTimeSeconds: number | null;

  @Index()
  @CreateDateColumn()
  createdAt: Date;
}