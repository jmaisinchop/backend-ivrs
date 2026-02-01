import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PostCallMenu, PostCallMenuOption } from './post-call-menu.entity';
import { Commitment, CommitmentSource } from './commitment.entity';
import { AgentService } from './agent.service';
import { CampaignService } from '../campaign/campaign.service';
import { DashboardGateway } from '../dashboard/dashboard.gateway';
import { HttpService } from '@nestjs/axios';
import { lastValueFrom } from 'rxjs';
import FormData from 'form-data';
import { ConfigService } from '@nestjs/config';
import dayjs from 'dayjs';

// Tiempo máximo que el sistema espera DTMF del cliente en el menú (8 segundos)
const MENU_DTMF_TIMEOUT_MS = 8000;

// Tiempo máximo para capturar el día del compromiso (15 segundos, puede marcar dos dígitos)
const COMMITMENT_DTMF_TIMEOUT_MS = 15000;

@Injectable()
export class PostCallService {
  private readonly logger = new Logger(PostCallService.name);

  constructor(
    @InjectRepository(PostCallMenu)
    private readonly menuRepo: Repository<PostCallMenu>,
    @InjectRepository(Commitment)
    private readonly commitmentRepo: Repository<Commitment>,
    private readonly agentService: AgentService,
    private readonly campaignService: CampaignService,
    private readonly dashboardGateway: DashboardGateway,
    private readonly http: HttpService,
    private readonly configService: ConfigService,
  ) {}

  // ─── CONSULTA DE MENÚ POR CAMPAÑA ────────────────────────────────────

  async getMenuByCampaignId(campaignId: string): Promise<PostCallMenu | null> {
    return this.menuRepo.findOne({
      where: { campaign: { id: campaignId } },
    });
  }

  // ─── CREAR / ACTUALIZAR MENÚ DE UNA CAMPAÑA ─────────────────────────

  async saveMenu(campaignId: string, data: {
    active: boolean;
    greeting?: string | null;
    options?: PostCallMenuOption[];
  }): Promise<PostCallMenu> {
    let menu = await this.menuRepo.findOne({
      where: { campaign: { id: campaignId } },
    });

    if (menu) {
      menu.active = data.active;
      if (data.greeting !== undefined) menu.greeting = data.greeting;
      if (data.options !== undefined) menu.options = data.options;
    } else {
      menu = this.menuRepo.create({
        campaign: { id: campaignId } as any,
        active: data.active,
        greeting: data.greeting || null,
        options: data.options || [],
      });
    }

    return this.menuRepo.save(menu);
  }

  // ─── PUNTO DE ENTRADA: se llama desde ami.service cuando termina el TTS ──
  // Recibe campaignId directamente desde ami.service (que lo tiene en flags)
  // así evitamos depender de findContactById que no carga la relación campaign.

  async handlePostCall(channel: any, contactId: string, campaignId: string): Promise<void> {
    if (!campaignId) {
      this.logger.warn(`[POST-CALL] Contacto ${contactId} sin campaignId. Colgando.`);
      channel.hangup().catch(() => {});
      return;
    }

    const menu = await this.getMenuByCampaignId(campaignId);

    // Si no hay menú activo → comportamiento original: hangup
    if (!menu || !menu.active) {
      this.logger.log(`[POST-CALL] Campaña ${campaignId} sin menú activo. Colgando.`);
      channel.hangup().catch(() => {});
      return;
    }

    this.logger.log(`[POST-CALL] Campaña ${campaignId} tiene menú activo. Iniciando flujo.`);

    // Generar y reproducir el saludo del menú
    const greetingText = menu.greeting || this.buildDefaultGreeting(menu.options);
    const greetingAudio = await this.generateTts(greetingText);

    if (!greetingAudio) {
      this.logger.error(`[POST-CALL] No se pudo generar TTS del saludo para campaña ${campaignId}. Colgando.`);
      channel.hangup().catch(() => {});
      return;
    }

    // Reproducir saludo y esperar
    await this.playAndWait(channel, greetingAudio).catch(() => {
      channel.hangup().catch(() => {});
      return;
    });

    // Capturar DTMF del menú con timeout
    const dtmfKey = await this.captureDtmf(channel, MENU_DTMF_TIMEOUT_MS);

    if (!dtmfKey) {
      this.logger.log(`[POST-CALL] Timeout DTMF menú. Contacto ${contactId}. Colgando.`);
      channel.hangup().catch(() => {});
      return;
    }

    // Buscar la opción que corresponde a la tecla
    const selectedOption = menu.options.find((opt) => opt.key === dtmfKey);

    if (!selectedOption) {
      this.logger.log(`[POST-CALL] Tecla ${dtmfKey} no válida en menú. Contacto ${contactId}. Colgando.`);
      channel.hangup().catch(() => {});
      return;
    }

    // Enrutar según la acción
    switch (selectedOption.action) {
      case 'payment_commitment':
        await this.handlePaymentCommitment(channel, contactId, campaignId);
        break;
      case 'transfer_agent':
        await this.handleTransferAgent(channel, contactId, campaignId);
        break;
      default:
        this.logger.warn(`[POST-CALL] Acción desconocida: ${selectedOption.action}. Colgando.`);
        channel.hangup().catch(() => {});
    }
  }

  // ─── FLUJO: COMPROMISO DE PAGO ───────────────────────────────────────

  private async handlePaymentCommitment(channel: any, contactId: string, campaignId: string): Promise<void> {
    this.logger.log(`[COMMITMENT] Iniciando flujo compromiso para contacto ${contactId}`);

    // Reproducir guía
    const guideAudio = await this.generateTts('Por favor ingrese el día de pago usando el teclado numérico.');
    if (guideAudio) {
      await this.playAndWait(channel, guideAudio).catch(() => {});
    }

    // Capturar dígitos del día (1 o 2 dígitos, ej: 5 o 15)
    const dayInput = await this.captureDtmfMultiple(channel, COMMITMENT_DTMF_TIMEOUT_MS, 2);

    if (!dayInput) {
      this.logger.log(`[COMMITMENT] Timeout captura día. Contacto ${contactId}. Colgando.`);
      channel.hangup().catch(() => {});
      return;
    }

    const day = Number.parseInt(dayInput, 10);

    // Validar día 1-28
    if (Number.isNaN(day) || day < 1 || day > 28) {
      const errorAudio = await this.generateTts('El día ingresado no es válido. Por favor inténtelo en otra oportunidad.');
      if (errorAudio) {
        await this.playAndWait(channel, errorAudio).catch(() => {});
      }
      channel.hangup().catch(() => {});
      return;
    }

    // Construir fecha: día ingresado + mes actual
    const commitmentDate = dayjs().date(day).startOf('day').toDate();

    // Validar laborable (lunes-viernes)
    const dayOfWeek = dayjs(commitmentDate).day(); // 0=dom, 6=sab
    if (dayOfWeek === 0 || dayOfWeek === 6) {
      const errorAudio = await this.generateTts('El día seleccionado no es laborable. Por favor inténtelo en otra oportunidad.');
      if (errorAudio) {
        await this.playAndWait(channel, errorAudio).catch(() => {});
      }
      channel.hangup().catch(() => {});
      return;
    }

    // Persistir compromiso
    const commitment = this.commitmentRepo.create({
      contact: { id: contactId } as any,
      commitmentDate,
      source: CommitmentSource.AUTOMATIC,
      attendedBy: null,
      note: null,
      campaignId,
    });
    await this.commitmentRepo.save(commitment);

    this.logger.log(`[COMMITMENT] Guardado. Contacto ${contactId} → día ${day}`);

    // Confirmar al cliente
    const confirmAudio = await this.generateTts(
      `Su compromiso de pago ha sido registrado para el día ${day} del mes actual. Gracias por su llamada.`,
    );
    if (confirmAudio) {
      await this.playAndWait(channel, confirmAudio).catch(() => {});
    }

    // Emitir por WebSocket
    this.dashboardGateway.broadcastToAdmins({
      event: 'commitment-created',
      contactId,
      campaignId,
      commitmentDate: commitmentDate.toISOString(),
      source: CommitmentSource.AUTOMATIC,
    });

    channel.hangup().catch(() => {});
  }

  // ─── FLUJO: TRANSFERENCIA A ASESOR ───────────────────────────────────

  private async handleTransferAgent(channel: any, contactId: string, campaignId: string): Promise<void> {
    this.logger.log(`[TRANSFER] Iniciando transferencia para contacto ${contactId}`);

    // Intentar transferencia directa.
    // AgentService.transferToAgent busca asesor libre y si existe
    // llama internamente a amiService.transferAgentBridge.
    const transferred = await this.agentService.transferToAgent(
      contactId,
      campaignId,
      channel,
    );

    if (transferred) {
      // Bridge activo, el resto lo maneja AmiService/AgentService
      return;
    }

    // No hay asesor libre → meter a cola y anunciar posición
    const position = await this.agentService.addToQueue(contactId, campaignId, channel);

    const positionAudio = await this.generateTts(
      `Todos los asesores están ocupados. Usted es el número ${position} en la fila. Por favor espere.`,
    );
    if (positionAudio) {
      await this.playAndWait(channel, positionAudio).catch(() => {});
    }

    // Si el cliente cuelga mientras espera en cola, se remueve automáticamente
    channel.once('StasisEnd', () => {
      this.agentService.removeFromQueue(contactId);
    });

    // La cola se procesa automáticamente desde AgentService cada 2s.
    // Cuando un asesor se libere, AgentService hace el bridge vía AmiService.
  }

  // ─── HELPERS ─────────────────────────────────────────────────────────

  private async playAndWait(channel: any, audioFilename: string): Promise<void> {
    return new Promise((resolve, reject) => {
      channel.play({ media: `sound:campanas/${audioFilename}` }, (err: any, playback: any) => {
        if (err) {
          reject(err);
          return;
        }
        playback.once('PlaybackFinished', () => resolve());
      });
    });
  }

  private captureDtmf(channel: any, timeoutMs: number): Promise<string | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        channel.removeAllListeners('ChannelDtmfReceived');
        resolve(null);
      }, timeoutMs);

      channel.once('ChannelDtmfReceived', (_event: any, dtmf: any) => {
        clearTimeout(timer);
        const digit = dtmf.digit || dtmf.variables?.digit;
        this.logger.log(`[DTMF] Capturado dígito: ${digit}`);
        resolve(digit || null);
      });
    });
  }

  private captureDtmfMultiple(channel: any, timeoutMs: number, maxDigits: number): Promise<string | null> {
    return new Promise((resolve) => {
      let captured = '';
      let digitTimeout: NodeJS.Timeout;

      const globalTimeout = setTimeout(() => {
        channel.removeAllListeners('ChannelDtmfReceived');
        resolve(captured.length > 0 ? captured : null);
      }, timeoutMs);

      const resetDigitTimeout = () => {
        if (digitTimeout) clearTimeout(digitTimeout);
        // Después de cada dígito, esperar 2s para ver si viene otro
        digitTimeout = setTimeout(() => {
          clearTimeout(globalTimeout);
          channel.removeAllListeners('ChannelDtmfReceived');
          resolve(captured.length > 0 ? captured : null);
        }, 2000);
      };

      const onDtmf = (_event: any, dtmf: any) => {
        const digit = dtmf.digit || dtmf.variables?.digit;
        if (!digit) return;

        captured += digit;
        this.logger.log(`[DTMF-MULTI] Capturado: "${captured}"`);

        if (captured.length >= maxDigits) {
          clearTimeout(globalTimeout);
          if (digitTimeout) clearTimeout(digitTimeout);
          channel.removeAllListeners('ChannelDtmfReceived');
          resolve(captured);
          return;
        }

        resetDigitTimeout();
      };

      channel.on('ChannelDtmfReceived', onDtmf);
      resetDigitTimeout();
    });
  }

  private async generateTts(text: string): Promise<string | null> {
    const form = new FormData();
    form.append('text', text);

    try {
      const { data } = await lastValueFrom(
        this.http.post<{ filename: string }>(
          this.configService.get<string>('TTS_URL'),
          form,
          {
            headers: form.getHeaders(),
            timeout: 10000,
          },
        ),
      );
      return data.filename?.replace(/\.gsm$/, '') || null;
    } catch (e: any) {
      this.logger.error(`[TTS] Error generando audio: ${e.message}`);
      return null;
    }
  }

  private buildDefaultGreeting(options: PostCallMenuOption[]): string {
    if (!options?.length) {
      return 'Gracias por su llamada. Adiós.';
    }

    const optionTexts = options.map((opt) => {
      switch (opt.action) {
        case 'transfer_agent':
          return `Para hablar con un asesor marque ${opt.key}`;
        case 'payment_commitment':
          return `Para registrar un compromiso de pago marque ${opt.key}`;
        default:
          return '';
      }
    }).filter(Boolean);

    return `Gracias por su llamada. ${optionTexts.join('. ')}. `;
  }
}