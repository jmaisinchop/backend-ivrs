import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  Index,
} from 'typeorm';
import { User } from '../user/user.entity';

/**
 * Registro histórico de descansos de asesores.
 * Cada vez que un asesor entra/sale de descanso, se crea un registro.
 * Útil para:
 *   - Reportes de productividad (tiempo en descanso vs disponible)
 *   - Auditoría de quién forzó estados
 *   - Análisis de patrones de descanso por asesor
 */
@Entity('agent_breaks')
@Index(['agent', 'startedAt'])
@Index(['startedAt'])
export class AgentBreak {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // ─── Asesor que tomó el descanso ─────────────────────────────────────────
  @ManyToOne(() => User, { eager: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'agent_id' })
  agent: User;

  @Column({ name: 'agent_id' })
  agentId: string;

  // ─── Timestamps del descanso ──────────────────────────────────────────────
  @Column({ name: 'started_at', type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  startedAt: Date;

  @Column({ name: 'ended_at', type: 'timestamp', nullable: true })
  endedAt: Date | null;

  // Duración en segundos (se calcula cuando termina el descanso)
  @Column({ name: 'duration_seconds', type: 'int', nullable: true })
  durationSeconds: number | null;

  // ─── Motivo y tipo ────────────────────────────────────────────────────────
  @Column({ name: 'reason', type: 'varchar', length: 100 })
  reason: string; // "Baño", "Lunch", "Otro", "Pausado por supervisor"

  @Column({ name: 'initiated_by', type: 'enum', enum: ['AGENT', 'SUPERVISOR'] })
  initiatedBy: 'AGENT' | 'SUPERVISOR';

  // Si fue forzado por un supervisor, registrar quién
  @ManyToOne(() => User, { eager: false, nullable: true })
  @JoinColumn({ name: 'forced_by_id' })
  forcedBy: User | null;

  @Column({ name: 'forced_by_id', nullable: true })
  forcedById: string | null;

  // ─── Estado al terminar ───────────────────────────────────────────────────
  // ¿El asesor volvió normalmente o se desconectó durante el descanso?
  @Column({
    name: 'end_reason',
    type: 'enum',
    enum: ['RETURNED', 'DISCONNECTED', 'FORCED_BY_SUPERVISOR', 'STILL_ACTIVE'],
    default: 'STILL_ACTIVE',
  })
  endReason: 'RETURNED' | 'DISCONNECTED' | 'FORCED_BY_SUPERVISOR' | 'STILL_ACTIVE';

  // ─── Metadata adicional ───────────────────────────────────────────────────
  @Column({ name: 'notes', type: 'text', nullable: true })
  notes: string | null;
}