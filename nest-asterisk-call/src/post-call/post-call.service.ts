import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, In } from 'typeorm';
import {
  PostCallMenu,
  PostCallMenuOption,
  PostCallMenuStep,
  ValidationRule,
} from './post-call-menu.entity';
import { Commitment, CommitmentSource } from './commitment.entity';
import { AgentCallEvent, AgentCallEventType } from './agent-call-event.entity';
import { AgentService } from './agent.service';
import { CampaignService } from '../campaign/campaign.service';
import { Campaign } from '../campaign/campaign.entity';
import { DashboardGateway } from '../dashboard/dashboard.gateway';
import { HttpService } from '@nestjs/axios';
import { lastValueFrom } from 'rxjs';
import FormData from 'form-data';
import { ConfigService } from '@nestjs/config';
import dayjs from 'dayjs';

// ─── CONSTANTES DE TIMEOUT ─────────────────────────────────────────────────
const MENU_DTMF_TIMEOUT_MS = 8000;       // Tiempo de espera tras terminar el audio del menú
const STEP_DTMF_TIMEOUT_MS = 15000;      // Tiempo de espera para cada pregunta dentro de una opción

// ─── INTERFAZ DEL CACHE TTS ────────────────────────────────────────────────
interface TtsCacheEntry {
  text: string;         // Texto original que generó este audio
  filename: string;     // Nombre del archivo generado por el servicio TTS
  generatedAt: number;  // Timestamp de cuando se generó (para TTL si hace falta)
}

@Injectable()
export class PostCallService implements OnModuleInit {
  private readonly logger = new Logger(PostCallService.name);

  // ─── CACHE TTS POR CAMPAÑA ─────────────────────────────────────────────
  // Key: campaignId → Value: map de texto → filename
  // Esto evita llamar al servicio TTS cada vez que hay una llamada
  // si el texto del menú no ha cambiado.
  private readonly ttsCache = new Map<string, Map<string, string>>();

  constructor(
    @InjectRepository(PostCallMenu)
    private readonly menuRepo: Repository<PostCallMenu>,
    @InjectRepository(Commitment)
    private readonly commitmentRepo: Repository<Commitment>,
    @InjectRepository(AgentCallEvent)
    private readonly eventRepo: Repository<AgentCallEvent>,
    @InjectRepository(Campaign)
    private readonly campaignRepo: Repository<Campaign>,
    private readonly agentService: AgentService,
    private readonly campaignService: CampaignService,
    private readonly dashboardGateway: DashboardGateway,
    private readonly http: HttpService,
    private readonly configService: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.logger.log('PostCallService inicializado. Cache TTS listo.');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // GESTIÓN DE MENÚS (CRUD)
  // ═══════════════════════════════════════════════════════════════════════════

  async getMenuByCampaignId(campaignId: string): Promise<PostCallMenu | null> {
    return this.menuRepo.findOne({
      where: { campaign: { id: campaignId } },
    });
  }

  async saveMenu(campaignId: string, data: {
    active: boolean;
    greeting?: string | null;
    options?: PostCallMenuOption[];
    queueMessage?: string | null;
    confirmationMessage?: string | null;
    errorMessage?: string | null;
  }): Promise<PostCallMenu> {

    this.logger.log(`[SAVE-MENU] Campaña ${campaignId} | active=${data.active}`);

    const existingMenu = await this.menuRepo.findOne({
      where: { campaign: { id: campaignId } },
    });

    // ─── Invalidar cache TTS de esta campaña ─────────────────────────────
    // Cuando se guarda el menú, los textos pueden haber cambiado,
    // así que eliminamos todo el cache de esta campaña.
    this.ttsCache.delete(campaignId);
    this.logger.log(`[SAVE-MENU] Cache TTS invalidado para campaña ${campaignId}`);

    if (existingMenu) {
      // MODO EDICIÓN
      await this.menuRepo.update(existingMenu.id, {
        active: data.active,
        greeting: data.greeting ?? existingMenu.greeting,
        options: data.options ?? existingMenu.options,
        queueMessage: data.queueMessage ?? existingMenu.queueMessage,
        confirmationMessage: data.confirmationMessage ?? existingMenu.confirmationMessage,
        errorMessage: data.errorMessage ?? existingMenu.errorMessage,
      });

      const fresh = await this.menuRepo.findOne({ where: { id: existingMenu.id } });
      this.logger.log(`[SAVE-MENU] Actualizado. active=${fresh?.active}`);
      return fresh!;
    } else {
      // MODO CREACIÓN
      const newMenu = this.menuRepo.create({
        campaign: { id: campaignId } as any,
        active: data.active,
        greeting: data.greeting || null,
        options: data.options || [],
        queueMessage: data.queueMessage || null,
        confirmationMessage: data.confirmationMessage || null,
        errorMessage: data.errorMessage || null,
      });
      const saved = await this.menuRepo.save(newMenu);
      this.logger.log(`[SAVE-MENU] Creado nuevo menú ID=${saved.id}. active=${saved.active}`);
      return saved;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LÓGICA PRINCIPAL: HANDLEPOSTCALL (IVR AUTOMÁTICO)
  // ═══════════════════════════════════════════════════════════════════════════

  async handlePostCall(channel: any, contactId: string, campaignId: string): Promise<void> {
    if (!campaignId) {
      channel.hangup().catch(() => {});
      return;
    }

    const menu = await this.getMenuByCampaignId(campaignId);

    if (!menu || !menu.active) {
      this.logger.log(`[POST-CALL] Menú inactivo para campaña ${campaignId}. Colgando.`);
      channel.hangup().catch(() => {});
      return;
    }

    this.logger.log(`[POST-CALL] Iniciando flujo para campaña ${campaignId}`);

    // ─── 1. Generar audio del greeting (con cache) ──────────────────────
    const greetingText = menu.greeting || this.buildDefaultGreeting(menu.options);
    const greetingAudio = await this.getTtsWithCache(campaignId, greetingText);

    if (!greetingAudio) {
      this.logger.error(`[POST-CALL] Fallo al generar TTS del greeting. Colgando.`);
      channel.hangup().catch(() => {});
      return;
    }

    // ─── 2. Reproducir greeting Y capturar DTMF EN PARALELO ─────────────
    // El cliente puede presionar una tecla MIENTRAS se reproduce el audio.
    // Si presiona tecla → se cancela el audio y se procede inmediatamente.
    // Si el audio termina sin tecla → se espera MENU_DTMF_TIMEOUT_MS adicionales.
    const dtmfKey = await this.playAndCaptureDtmf(channel, greetingAudio, MENU_DTMF_TIMEOUT_MS);

    if (!dtmfKey) {
      this.logger.log(`[POST-CALL] Timeout DTMF en menú principal. Colgando.`);
      // Reproducir mensaje de error si está configurado
      const errorText = menu.errorMessage || 'No se recibió respuesta. Adiós.';
      const errorAudio = await this.getTtsWithCache(campaignId, errorText);
      if (errorAudio) await this.playAndWait(channel, errorAudio).catch(() => {});
      channel.hangup().catch(() => {});
      return;
    }

    // ─── 3. Buscar la opción seleccionada ────────────────────────────────
    const selectedOption = menu.options.find((opt) => opt.key === dtmfKey);

    if (!selectedOption) {
      this.logger.log(`[POST-CALL] Opción inválida: tecla '${dtmfKey}'. Colgando.`);
      const errorText = menu.errorMessage || 'Opción no válida. Adiós.';
      const errorAudio = await this.getTtsWithCache(campaignId, errorText);
      if (errorAudio) await this.playAndWait(channel, errorAudio).catch(() => {});
      channel.hangup().catch(() => {});
      return;
    }

    this.logger.log(`[POST-CALL] Opción seleccionada: key='${selectedOption.key}' action='${selectedOption.action}'`);

    // ─── 4. Ejecutar los steps de la opción (preguntas encadenadas) ──────
    const answers = await this.executeSteps(channel, campaignId, selectedOption.steps);

    // Si answers es null, significa que el cliente colgó o hubo timeout en algún step
    if (answers === null) {
      this.logger.log(`[POST-CALL] Cliente no completó los steps. Colgando.`);
      channel.hangup().catch(() => {});
      return;
    }

    // ─── 5. Ejecutar la acción según el tipo ─────────────────────────────
    switch (selectedOption.action) {
      case 'payment_commitment':
        await this.handlePaymentCommitment(channel, contactId, campaignId, menu, answers);
        break;
      case 'transfer_agent':
        await this.handleTransferAgent(channel, contactId, campaignId, menu);
        break;
      default:
        channel.hangup().catch(() => {});
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EJECUCIÓN DE STEPS (PREGUNTAS ENCADENADAS POR OPCIÓN)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Ejecuta los steps de una opción secuencialmente.
   * Retorna un Map con las respuestas: { saveAs → valor }
   * Retorna null si el cliente colgó o hubo timeout en algún paso.
   */
  private async executeSteps(
    channel: any,
    campaignId: string,
    steps: PostCallMenuStep[],
  ): Promise<Map<string, string> | null> {
    const answers = new Map<string, string>();

    // Si no hay steps, la opción no tiene preguntas (ej: transfer_agent)
    if (!steps || steps.length === 0) {
      return answers;
    }

    for (const step of steps) {
      this.logger.log(`[STEP] Ejecutando step saveAs='${step.saveAs}' prompt='${step.prompt.substring(0, 50)}...'`);

      // 1. Generar audio del prompt
      const promptAudio = await this.getTtsWithCache(campaignId, step.prompt);
      if (!promptAudio) {
        this.logger.error(`[STEP] Fallo TTS en prompt '${step.prompt}'. Abortando steps.`);
        return null;
      }

      // 2. Reproducir prompt y capturar respuesta según tipo de captura
      let captured: string | null = null;

      if (step.capture === 'single_digit') {
        // Captura un solo dígito (se resuelve al primer keystroke)
        captured = await this.playAndCaptureDtmf(channel, promptAudio, STEP_DTMF_TIMEOUT_MS);
      } else if (step.capture === 'numeric') {
        // Captura múltiples dígitos
        captured = await this.playAndCaptureDtmfMultiple(
          channel,
          promptAudio,
          STEP_DTMF_TIMEOUT_MS,
          step.maxDigits || 2,
        );
      }

      if (!captured) {
        this.logger.log(`[STEP] Timeout en step '${step.saveAs}'. Cliente no respondió.`);
        return null;
      }

      // 3. Validar la respuesta
      const validationResult = this.validateInput(captured, step.validation);

      if (!validationResult.valid) {
        this.logger.log(`[STEP] Validación falló en '${step.saveAs}': valor='${captured}' regla='${step.validation}'`);
        // Reproducir mensaje de error del step
        const errorAudio = await this.getTtsWithCache(campaignId, step.errorMessage);
        if (errorAudio) await this.playAndWait(channel, errorAudio).catch(() => {});
        return null; // Abortamos todo el flujo
      }

      // 4. Guardar respuesta
      answers.set(step.saveAs, captured);
      this.logger.log(`[STEP] Respuesta capturada: ${step.saveAs} = '${captured}'`);
    }

    return answers;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FLUJOS DE ACCIÓN (DESPUÉS DE COMPLETAR STEPS)
  // ═══════════════════════════════════════════════════════════════════════════

  private async handlePaymentCommitment(
    channel: any,
    contactId: string,
    campaignId: string,
    menu: PostCallMenu,
    answers: Map<string, string>,
  ): Promise<void> {

    // Extraer el día capturado de los answers
    const dayStr = answers.get('commitmentDay');
    if (!dayStr) {
      this.logger.warn(`[COMMITMENT] No se encontró 'commitmentDay' en las respuestas. Answers:`, Object.fromEntries(answers));
      channel.hangup().catch(() => {});
      return;
    }

    const day = parseInt(dayStr, 10);
    const commitmentDate = dayjs().date(day).startOf('day').toDate();

    // Guardar compromiso
    const commitment = this.commitmentRepo.create({
      contact: { id: contactId } as any,
      commitmentDate,
      source: CommitmentSource.AUTOMATIC,
      attendedBy: null,
      note: null,
      campaignId,
    });
    await this.commitmentRepo.save(commitment);
    this.logger.log(`[COMMITMENT-AUTO] Contacto ${contactId} día ${day}`);

    // Reproducir confirmación (con placeholder {day})
    const confirmTemplate = menu.confirmationMessage || 'Su compromiso ha sido registrado para el día {day}. Gracias por su llamada.';
    const confirmText = confirmTemplate.replace('{day}', dayStr);
    const confirmAudio = await this.getTtsWithCache(campaignId, confirmText);
    if (confirmAudio) await this.playAndWait(channel, confirmAudio).catch(() => {});

    // Emitir evento al dashboard
    this.dashboardGateway.broadcastToAdmins({
      event: 'commitment-created',
      contactId,
      campaignId,
      commitmentDate: commitmentDate.toISOString(),
      source: CommitmentSource.AUTOMATIC,
    });

    channel.hangup().catch(() => {});
  }

  private async handleTransferAgent(
    channel: any,
    contactId: string,
    campaignId: string,
    menu: PostCallMenu,
  ): Promise<void> {
    this.logger.log(`[TRANSFER] Transfiriendo contacto ${contactId}`);

    const transferred = await this.agentService.transferToAgent(contactId, campaignId, channel);
    if (transferred) return; // Si se transfiere directamente, no hay más que hacer

    // ─── Cliente va a cola de espera ──────────────────────────────────────
    const position = await this.agentService.addToQueue(contactId, campaignId, channel);

    // Reproducir mensaje de espera (con placeholder {position})
    const queueTemplate = menu.queueMessage || 'Todos los asesores están ocupados. Usted es el número {position} en la fila. Por favor espere.';
    const queueText = queueTemplate.replace('{position}', String(position));
    const queueAudio = await this.getTtsWithCache(campaignId, queueText);
    if (queueAudio) await this.playAndWait(channel, queueAudio).catch(() => {});

    // Escuchar si el cliente cuelga mientras está en cola
    channel.once('StasisEnd', () => {
      this.agentService.removeFromQueue(contactId);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CACHE TTS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Obtiene el audio TTS para un texto dado, usando cache por campaña.
   * Si el texto ya fue generado para esta campaña, retorna el filename cacheado.
   * Si no, llama al servicio TTS, cachea el resultado, y lo retorna.
   */
  private async getTtsWithCache(campaignId: string, text: string): Promise<string | null> {
    // Inicializar el map de la campaña si no existe
    if (!this.ttsCache.has(campaignId)) {
      this.ttsCache.set(campaignId, new Map());
    }
    const campaignCache = this.ttsCache.get(campaignId)!;

    // Verificar si ya tenemos este texto cacheado
    if (campaignCache.has(text)) {
      this.logger.log(`[TTS-CACHE] Hit para campaña ${campaignId}. Texto: '${text.substring(0, 40)}...'`);
      return campaignCache.get(text)!;
    }

    // Cache miss → generar TTS
    this.logger.log(`[TTS-CACHE] Miss para campaña ${campaignId}. Generando TTS...`);
    const filename = await this.generateTts(text);

    if (filename) {
      campaignCache.set(text, filename);
      this.logger.log(`[TTS-CACHE] Guardado en cache: '${text.substring(0, 40)}...' → ${filename}`);
    }

    return filename;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HELPERS: AUDIO + DTMF
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Reproduce un audio Y captura DTMF EN PARALELO.
   * - Si el cliente presiona una tecla DURANTE el audio → cancela el audio, retorna la tecla.
   * - Si el audio termina sin tecla → espera timeoutMs adicionales para captura.
   * - Si no llega tecla en todo el proceso → retorna null.
   */
  private async playAndCaptureDtmf(
    channel: any,
    audioFilename: string,
    timeoutMs: number,
  ): Promise<string | null> {
    return new Promise((resolve) => {
      let resolved = false;
      let playback: any = null;

      // ─── Timeout global (cubre todo: audio + espera posterior) ─────────
      const globalTimeout = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        channel.removeAllListeners('ChannelDtmfReceived');
        resolve(null);
      }, timeoutMs + 30000); // Audio puede durar hasta 30s + timeout de espera

      // ─── Escuchar DTMF desde el momento en que empieza el audio ────────
      const onDtmf = (event: any) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(globalTimeout);
        channel.removeAllListeners('ChannelDtmfReceived');
        // Si el audio sigue reproduciéndose, cancelarlo
        if (playback) {
          playback.stop().catch(() => {});
        }
        resolve(event.digit || null);
      };
      channel.on('ChannelDtmfReceived', onDtmf);

      // ─── Iniciar playback ───────────────────────────────────────────────
      channel.play({ media: `sound:campanas/${audioFilename}` }, (err: any, pb: any) => {
        if (err) {
          if (!resolved) {
            resolved = true;
            clearTimeout(globalTimeout);
            channel.removeAllListeners('ChannelDtmfReceived');
            resolve(null);
          }
          return;
        }
        playback = pb;

        // Cuando el audio termina sin que el cliente presione tecla,
        // seguimos esperando timeoutMs adicionales
        pb.once('PlaybackFinished', () => {
          if (resolved) return;
          // No resolvemos aquí. El globalTimeout seguirá esperando.
          // El cliente aún puede presionar tecla durante los timeoutMs restantes.
          this.logger.log(`[DTMF] Audio terminó. Esperando tecla por ${timeoutMs}ms más.`);

          // Ajustamos: desde aquí esperamos solo timeoutMs
          setTimeout(() => {
            if (resolved) return;
            resolved = true;
            clearTimeout(globalTimeout);
            channel.removeAllListeners('ChannelDtmfReceived');
            resolve(null);
          }, timeoutMs);
        });
      });
    });
  }

  /**
   * Reproduce audio Y captura múltiples dígitos DTMF en paralelo.
   * Mismo concepto que playAndCaptureDtmf pero captura hasta maxDigits.
   */
  private async playAndCaptureDtmfMultiple(
    channel: any,
    audioFilename: string,
    timeoutMs: number,
    maxDigits: number,
  ): Promise<string | null> {
    return new Promise((resolve) => {
      let resolved = false;
      let playback: any = null;
      let captured = '';
      let digitTimeout: NodeJS.Timeout;

      const finish = (result: string | null) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(globalTimeout);
        if (digitTimeout) clearTimeout(digitTimeout);
        channel.removeAllListeners('ChannelDtmfReceived');
        if (playback) playback.stop().catch(() => {});
        resolve(result);
      };

      const globalTimeout = setTimeout(() => {
        finish(captured.length > 0 ? captured : null);
      }, timeoutMs + 30000);

      // Timeout entre dígitos: si pasan 2s sin nuevo dígito, aceptamos lo que tenemos
      const resetDigitTimeout = () => {
        if (digitTimeout) clearTimeout(digitTimeout);
        digitTimeout = setTimeout(() => {
          finish(captured.length > 0 ? captured : null);
        }, 2000);
      };

      const onDtmf = (event: any) => {
        if (resolved) return;
        const digit = event.digit;
        if (!digit) return;

        // Si el audio sigue, cancelarlo al recibir primer dígito
        if (playback && captured.length === 0) {
          playback.stop().catch(() => {});
        }

        captured += digit;

        if (captured.length >= maxDigits) {
          finish(captured);
          return;
        }
        resetDigitTimeout();
      };

      channel.on('ChannelDtmfReceived', onDtmf);

      // Iniciar playback
      channel.play({ media: `sound:campanas/${audioFilename}` }, (err: any, pb: any) => {
        if (err) { finish(null); return; }
        playback = pb;

        pb.once('PlaybackFinished', () => {
          if (resolved) return;
          // Audio terminó, esperamos dígitos con timeout
          resetDigitTimeout();
        });
      });
    });
  }

  /**
   * Reproduce un audio y espera a que termine. Sin captura DTMF.
   * Se usa para mensajes que no necesitan respuesta (confirmación, error final, etc.)
   */
  private async playAndWait(channel: any, audioFilename: string): Promise<void> {
    return new Promise((resolve, reject) => {
      channel.play({ media: `sound:campanas/${audioFilename}` }, (err: any, playback: any) => {
        if (err) { reject(err); return; }
        playback.once('PlaybackFinished', () => resolve());
      });
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // VALIDACIÓN DE INPUT
  // ═══════════════════════════════════════════════════════════════════════════

  private validateInput(value: string, rule: ValidationRule): { valid: boolean; reason?: string } {
    switch (rule) {
      case 'day_1_28': {
        const num = parseInt(value, 10);
        if (isNaN(num) || num < 1 || num > 28) {
          return { valid: false, reason: `Valor '${value}' fuera de rango 1-28` };
        }
        return { valid: true };
      }
      case 'day_laborable': {
        const num = parseInt(value, 10);
        if (isNaN(num) || num < 1 || num > 28) {
          return { valid: false, reason: `Valor '${value}' fuera de rango 1-28` };
        }
        // Verificar si el día cae en fin de semana (usando el mes actual)
        const date = dayjs().date(num);
        const dayOfWeek = date.day(); // 0=domingo, 6=sábado
        if (dayOfWeek === 0 || dayOfWeek === 6) {
          return { valid: false, reason: `Día ${num} cae en fin de semana` };
        }
        return { valid: true };
      }
      case 'none':
      default:
        return { valid: true };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TTS (GENERACIÓN DE AUDIO)
  // ═══════════════════════════════════════════════════════════════════════════

  private async generateTts(text: string): Promise<string | null> {
    const form = new FormData();
    form.append('text', text);

    try {
      const { data } = await lastValueFrom(
        this.http.post<{ filename: string }>(
          this.configService.get<string>('TTS_URL'),
          form,
          { headers: form.getHeaders(), timeout: 10000 },
        ),
      );
      return data.filename?.replace(/\.gsm$/, '') || null;
    } catch (e: any) {
      this.logger.error(`[TTS] Error generando audio: ${e.message}`);
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HELPERS DE TEXTO
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Construye el greeting por defecto cuando no se especifica uno custom.
   * Auto-genera el texto basándose en las opciones configuradas.
   */
  private buildDefaultGreeting(options: PostCallMenuOption[]): string {
    if (!options?.length) return 'Gracias por su llamada. Adiós.';

    const optionTexts = options.map((opt) => {
      switch (opt.action) {
        case 'transfer_agent':
          return `Para hablar con un asesor marque ${opt.key}`;
        case 'payment_commitment':
          return `Para registrar un compromiso de pago marque ${opt.key}`;
        default:
          return opt.text || '';
      }
    }).filter(Boolean);

    return `Gracias por su llamada. ${optionTexts.join('. ')}. `;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HISTORIAL Y COMPROMISOS (sin cambios de lógica)
  // ═══════════════════════════════════════════════════════════════════════════

  async getAgentHistory(agentId: string, filters?: { startDate?: string; endDate?: string }) {
    let start = dayjs().startOf('day').toDate();
    let end = dayjs().endOf('day').toDate();

    if (filters?.startDate) {
      start = dayjs(filters.startDate).startOf('day').toDate();
      end = filters.endDate
        ? dayjs(filters.endDate).endOf('day').toDate()
        : dayjs(filters.startDate).endOf('day').toDate();
    }

    const events = await this.eventRepo.find({
      where: {
        agent: { id: agentId },
        eventType: AgentCallEventType.FINISHED,
        createdAt: Between(start, end),
      },
      relations: ['contact'],
      order: { createdAt: 'DESC' },
    });

    if (events.length === 0) return [];

    const commitments = await this.commitmentRepo.find({
      where: {
        attendedBy: { id: agentId },
        createdAt: Between(start, end),
      },
      relations: ['contact'],
    });

    const campaignIds = [...new Set(events.map(e => e.campaignId).filter(id => id && id !== ''))];
    const campaignNames = new Map<string, string>();

    if (campaignIds.length > 0) {
      try {
        const campaigns = await this.campaignRepo.find({
          where: { id: In(campaignIds) },
          select: ['id', 'name'],
        });
        campaigns.forEach(c => campaignNames.set(c.id, c.name));
      } catch (e) {
        this.logger.error('Error consultando nombres de campañas', e);
      }
    }

    return events.map(event => {
      const relatedCommitment = commitments.find(c =>
        c.contact.id === event.contact.id &&
        Math.abs(dayjs(c.createdAt).diff(dayjs(event.createdAt), 'minute')) < 30,
      );

      const c: any = event.contact || {};
      let contactName = 'Desconocido';
      if (c.name && c.name.trim() !== '') contactName = c.name;
      else if (c.firstName) contactName = `${c.firstName} ${c.lastName || ''}`.trim();

      return {
        id: event.id,
        contactName,
        contactIdentification: c.identification || '—',
        contactPhone: c.phone || '—',
        duration: event.durationSeconds || 0,
        campaignName: event.campaignId ? (campaignNames.get(event.campaignId) || 'Campaña Desconocida') : 'Campaña General',
        status: 'FINISHED',
        connectedAt: event.createdAt,
        commitment: relatedCommitment ? {
          promisedDate: relatedCommitment.commitmentDate,
          registeredBy: relatedCommitment.source,
        } : null,
      };
    });
  }

  async createManualCommitment(dto: {
    contactId: string;
    campaignId: string;
    promisedDate: string;
    agentId: string;
    notes?: string;
  }): Promise<Commitment> {
    if (!dto.promisedDate) throw new Error('La fecha de compromiso es obligatoria');

    const dateObj = dayjs(dto.promisedDate);
    if (!dateObj.isValid()) throw new Error(`Fecha inválida: ${dto.promisedDate}`);

    const commitment = this.commitmentRepo.create({
      contact: { id: dto.contactId } as any,
      campaignId: dto.campaignId,
      attendedBy: { id: dto.agentId } as any,
      commitmentDate: dateObj.toDate(),
      source: CommitmentSource.MANUAL,
      note: dto.notes || null,
      createdAt: new Date(),
    });

    const saved = await this.commitmentRepo.save(commitment);
    this.logger.log(`[COMMITMENT-MANUAL] Guardado por agente ${dto.agentId}`);

    this.dashboardGateway.broadcastToAdmins({
      event: 'commitment-created',
      contactId: dto.contactId,
      campaignId: dto.campaignId,
      commitmentDate: dateObj.toISOString(),
      source: CommitmentSource.MANUAL,
      agentId: dto.agentId,
      commitment: saved,
    });

    this.dashboardGateway.sendUpdate({
      event: 'commitment-created',
      contactId: dto.contactId,
      commitment: saved,
    }, dto.agentId);

    return saved;
  }
}