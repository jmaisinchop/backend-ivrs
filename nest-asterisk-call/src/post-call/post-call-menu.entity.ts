import { Entity, PrimaryGeneratedColumn, Column, OneToOne, JoinColumn, CreateDateColumn, UpdateDateColumn } from 'typeorm';
import { Campaign } from '../campaign/campaign.entity';

@Entity('post_call_menu')
export class PostCallMenu {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // 1:1 con campaña. Solo las campañas que lo activen tienen registro aquí.
  @OneToOne(() => Campaign, { onDelete: 'CASCADE' })
  @JoinColumn()
  campaign: Campaign;

  // Si el menú post-llamada está activo para esta campaña
  @Column({ default: false })
  active: boolean;

  // Texto del saludo que se genera como TTS al final de la llamada automática.
  // Ejemplo: "Gracias por su llamada. Para hablar con un asesor marque 1. Para registrar un compromiso de pago marque 2."
  // Si está vacío, se usa el saludo por defecto del sistema.
  @Column({ type: 'text', nullable: true })
  greeting: string | null;

  // Opciones disponibles en el menú.
  // Cada opción tiene: tecla DTMF, tipo de acción, texto TTS.
  // Ejemplo: [{ key: '1', action: 'transfer_agent', text: 'Para hablar con un asesor marque 1' },
  //           { key: '2', action: 'payment_commitment', text: 'Para registrar un compromiso marque 2' }]
  @Column({ type: 'jsonb', default: [] })
  options: PostCallMenuOption[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

export type PostCallMenuOptionAction = 'transfer_agent' | 'payment_commitment';

export interface PostCallMenuOption {
  key: string;                        // Tecla DTMF: '1', '2', etc.
  action: PostCallMenuOptionAction;   // Qué hace al presionar esa tecla
  text: string;                       // Texto que se anuncia para esa opción (parte del saludo)
}