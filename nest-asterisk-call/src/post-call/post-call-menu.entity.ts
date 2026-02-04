import { Entity, PrimaryGeneratedColumn, Column, OneToOne, JoinColumn, CreateDateColumn, UpdateDateColumn } from 'typeorm';
import { Campaign } from '../campaign/campaign.entity';

@Entity('post_call_menu')
export class PostCallMenu {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @OneToOne(() => Campaign, { onDelete: 'CASCADE' })
  @JoinColumn()
  campaign: Campaign;

  // Si el menú post-llamada está activo para esta campaña
  @Column({ default: false })
  active: boolean;

  // ─── SALUDO PRINCIPAL ────────────────────────────────────────────────────
  // Texto completo que se reproduce al inicio del menú.
  // Ejemplo: "Gracias por su llamada. Para hablar con un asesor marque 1. Para registrar un compromiso marque 2."
  // Si está vacío, se auto-genera con buildDefaultGreeting()
  @Column({ type: 'text', nullable: true })
  greeting: string | null;

  // ─── OPCIONES DEL MENÚ ───────────────────────────────────────────────────
  // Cada opción puede tener steps (preguntas encadenadas).
  // El array puede tener 1, 2 o más opciones.
  @Column({ type: 'jsonb', default: [] })
  options: PostCallMenuOption[];

  // ─── MENSAJES CONFIGURABLES ──────────────────────────────────────────────
  // Mensaje que se reproduce cuando el cliente está en cola de espera.
  // Soporta placeholder {position} que se reemplaza en runtime.
  // Ejemplo: "Usted es el número {position} en la fila. Por favor espere."
  @Column({ type: 'text', nullable: true })
  queueMessage: string | null;

  // Mensaje de confirmación exitosa (ej: cuando se guarda un compromiso)
  // Soporta placeholder {day} para el día capturado.
  // Ejemplo: "Su compromiso ha sido registrado para el día {day}. Gracias por su llamada."
  @Column({ type: 'text', nullable: true })
  confirmationMessage: string | null;

  // Mensaje de error genérico (cuando el cliente ingresa algo inválido en el menú principal)
  // Ejemplo: "Entrada no válida. Por favor intente nuevamente."
  @Column({ type: 'text', nullable: true })
  errorMessage: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

// ─── TIPOS DE ACCIONES DISPONIBLES ──────────────────────────────────────────
export type PostCallMenuOptionAction = 'transfer_agent' | 'payment_commitment';

// ─── TIPOS DE CAPTURA DTMF ──────────────────────────────────────────────────
// single_digit: captura UNA sola tecla inmediatamente
// numeric:      captura múltiples dígitos numéricos (se detiene por timeout entre dígitos o al llegar a maxDigits)
export type DtmfCaptureType = 'single_digit' | 'numeric';

// ─── REGLAS DE VALIDACIÓN DISPONIBLES ───────────────────────────────────────
// day_1_28:       número entre 1 y 28 (para días de pago)
// day_laborable:  día entre 1-28 que no cae en fin de semana (se calcula runtime)
// none:           sin validación, acepta cualquier entrada
export type ValidationRule = 'day_1_28' | 'day_laborable' | 'none';

// ─── PASO DE PREGUNTA DENTRO DE UNA OPCIÓN ──────────────────────────────────
export interface PostCallMenuStep {
  prompt: string;                 // Texto TTS que reproduce antes de esperar input
  capture: DtmfCaptureType;       // Tipo de captura
  maxDigits?: number;             // Solo aplica a 'numeric'. Ej: 2 para un día (01-28)
  validation: ValidationRule;     // Qué validar con la respuesta
  errorMessage: string;           // Qué decir si la validación falla
  saveAs: string;                 // Identificador de qué dato captura. Ej: 'commitmentDay'
}

// ─── OPCIÓN DEL MENÚ ────────────────────────────────────────────────────────
export interface PostCallMenuOption {
  key: string;                        // Tecla DTMF: '1', '2', etc.
  action: PostCallMenuOptionAction;   // Qué tipo de flujo se ejecuta al presionar esta tecla
  text: string;                       // Texto que se anuncia para esta opción (parte del greeting)
  steps: PostCallMenuStep[];          // Preguntas que se hacen después de presionar la tecla. Puede estar vacío (ej: transfer_agent no tiene preguntas)
}