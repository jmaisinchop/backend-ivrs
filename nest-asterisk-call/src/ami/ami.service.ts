
import {
  Injectable,
  OnModuleInit,
  Logger,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { lastValueFrom } from 'rxjs';
import FormData from 'form-data';
import { v4 as uuidv4 } from 'uuid';
const AriClient = require('ari-client');
import { CampaignService } from '../campaign/campaign.service';
import { ConfigService } from '@nestjs/config';
import { DashboardGateway } from 'src/dashboard/dashboard.gateway';

const WS_RETRY_MS = 3000;
const ORIGINATE_TIMEOUT_MS = 70000; // Sigue siendo el máximo absoluto


const CAUSES: Record<number | string, string> = { // Permitir string para -99 si lo usamos
  1: 'Número no asignado',
  16: 'Finalización normal',
  17: 'Ocupado',
  18: 'Sin respuesta',
  19: 'No contestó', // A menudo, este es el resultado de un timeout de ringing sin respuesta explícita
  21: 'Rechazado',
  28: 'Número inválido',
  31: 'Fallo general',
  34: 'Canal no disponible',
};

interface CallFlags { contactId: string; rang: boolean; up: boolean; }
// Modificado para incluir timestamps
interface CallResult {
  success: boolean;
  causeNum: string;
  causeMsg: string;
  startedAt: Date | null;
  answeredAt: Date | null;
  finishedAt: Date | null;
}

@Injectable()
export class AmiService implements OnModuleInit {
  private readonly logger = new Logger('AmiService');
  private ari: any;

  private readonly trunks = ['gsmDinstar', 'gsmDinstar2', 'gsmDinstar3', 'gsmDinstar5'];
  private flags = new Map<string, CallFlags>();

  constructor(
    private readonly http: HttpService,
    @Inject(forwardRef(() => CampaignService))
    private readonly campaigns: CampaignService,
    private readonly configService: ConfigService,
    private readonly dashboardGateway: DashboardGateway,
  ) { }

  async onModuleInit(): Promise<void> { await this.connectAri(); }

  private async connectAri(): Promise<void> {
    try {
      this.ari = await AriClient.connect(
        this.configService.get<string>('ARI_URL'),
        this.configService.get<string>('ARI_USERNAME'),
        this.configService.get<string>('ARI_PASSWORD'),
      );
      this.ari.on('WebSocketClose', () => {
        this.logger.error('WebSocket ARI cerrado, reintentando...');
        setTimeout(() => this.connectAri(), WS_RETRY_MS);
      });
      await this.ari.start('stasis-app');
      this.logger.log('Conectado a ARI');
    } catch (err: any) {
      this.logger.error(`Error conectando a ARI: ${err.message}`);
      setTimeout(() => this.connectAri(), WS_RETRY_MS);
    }
  }

  public async callWithTTS(text: string, phone: string, contactId: string): Promise<void> {
    this.logger.log(`[${contactId}] Inicio callWithTTS ${phone}`);
    const initialCallAttemptStartedAt = new Date(); // Momento en que se intenta la llamada inicialmente
    // Persiste CALLING con la hora de inicio del intento de llamada general
    this.dashboardGateway.sendUpdate({ event: 'call-initiated' });
    await this.persist(contactId, 'CALLING', '', 'Calling', initialCallAttemptStartedAt, null, null).catch(() => { });

    const audio = await this.generateTts(text).catch(() => null);
    if (!audio) {
      this.dashboardGateway.sendUpdate({ event: 'call-finished' });
      // Si falla TTS, persistimos con la hora de inicio del intento y la hora actual como finalización
      await this.persist(contactId, 'FAILED', '', 'TTS ERROR', initialCallAttemptStartedAt, null, new Date()).catch(() => { });
      return;
    }
    this.logger.log(`[${contactId}] Audio listo (${audio})`);

    let final: CallResult = {
      success: false,
      causeNum: '',
      causeMsg: 'No trunks attempted',
      startedAt: initialCallAttemptStartedAt, // Usar la hora de inicio del intento general
      answeredAt: null,
      finishedAt: new Date() // Por defecto, si no se intenta ninguna troncal
    };

    for (const trunk of this.trunks) {
      this.logger.log(`[${contactId}] Probando troncal ${trunk} con audio ${audio}`);
      let attemptSpecificStartedAt = new Date(); // Hora de inicio para ESTE intento de troncal
      try {
        // tryCallRaw ahora devolverá los timestamps específicos de ese intento
        final = await this.tryCallRaw(contactId, trunk, phone, audio, attemptSpecificStartedAt);
      } catch (e: any) {
        this.logger.error(`[${contactId}] Error catastrófico en tryCallRaw con troncal ${trunk}: ${e.message}`);
        final = {
          success: false,
          causeNum: 'ERROR_INTERNO',
          causeMsg: 'Error originando llamada',
          startedAt: attemptSpecificStartedAt, // Hora de inicio de este intento fallido específico
          answeredAt: null,
          finishedAt: new Date() // Hora de fin de este intento fallido específico
        };
      }
      // Si la llamada fue exitosa, contestada (incluso si ocupado), o si se completó normalmente, salimos del bucle.
      if (final.success || final.causeNum === '16' || final.causeNum === '17') {
        break;
      }
    }

    // Usar el initialCallAttemptStartedAt para el startedAt final que se persiste,
    // a menos que el 'final.startedAt' (del último tryCallRaw) sea más relevante y exista.
    // En general, el 'initialCallAttemptStartedAt' marca el inicio del proceso de 'callWithTTS'.
    // Los 'final.answeredAt' y 'final.finishedAt' vienen del intento de troncal más relevante.
    await this.persist(
      contactId,
      final.success ? 'SUCCESS' : 'FAILED',
      final.causeNum,
      final.causeMsg,
      initialCallAttemptStartedAt, // Hora de inicio del proceso general de callWithTTS
      final.answeredAt,           // Hora de contestación del intento exitoso (o último intento)
      final.finishedAt,           // Hora de finalización del intento exitoso (o último intento)
    ).catch(() => { });
    this.logger.log(`[${contactId}] Resultado final → ${final.causeMsg}`);
  }

  private async tryCallRaw(
    contactId: string, trunk: string, phone: string, audio: string,
    attemptStartedAt: Date // Recibe la hora de inicio del intento de esta troncal
  ): Promise<CallResult> {
    const callId = uuidv4();
    this.flags.set(callId, { contactId, rang: false, up: false });
    this.logger.log(`[${callId}] Originando ${phone} via ${trunk} (Attempt started: ${attemptStartedAt.toISOString()})`);

    let ariChannel: any = null;
    let eventCauseCode = -1;
    let eventChannelDestroyed = false;

    // Timestamps para este intento de llamada específico
    // attemptStartedAt ya se recibe como parámetro
    let attemptAnsweredAt: Date | null = null;
    let attemptFinishedAt: Date | null = null;

    return new Promise<CallResult>((resolve) => {
      let isPromiseResolved = false;

      const resolveOnce = (result: Omit<CallResult, 'startedAt' | 'answeredAt' | 'finishedAt'>) => {
        if (!isPromiseResolved) {
          isPromiseResolved = true;
          if (!attemptFinishedAt) attemptFinishedAt = new Date(); // Marcar la hora de finalización si no se hizo antes
          if (mainTimeoutId) clearTimeout(mainTimeoutId);
          this.flags.delete(callId);
          resolve({
            ...result,
            startedAt: attemptStartedAt, // Este es el attemptStartedAt de este intento de troncal
            answeredAt: attemptAnsweredAt,
            finishedAt: attemptFinishedAt
          });
        }
      };

      const mainTimeoutId = setTimeout(() => {
        if (isPromiseResolved) return;
        this.logger.warn(`[${callId}] Timeout principal (${ORIGINATE_TIMEOUT_MS}ms) alcanzado.`);
        attemptFinishedAt = new Date(); // Timeout es una forma de finalización

        if (ariChannel && !eventChannelDestroyed) {
          this.logger.warn(`[${callId}] Forzando hangup del canal por timeout principal.`);
          ariChannel.hangup().catch((err: any) => {
            this.logger.error(`[${callId}] Error al colgar en timeout principal: ${err.message}`);
          });
        }
        const currentFlags = this.flags.get(callId) || { contactId, rang: false, up: false };
        resolveOnce(this.interpret(eventCauseCode, currentFlags.up, true));

      }, ORIGINATE_TIMEOUT_MS);

      // attemptStartedAt ya se estableció y pasó como parámetro
      this.ari.channels.originate({
        endpoint: `SIP/${trunk}/${phone}`,
        app: 'stasis-app',
        callerId: `IVR-${callId}`,
        timeout: 45,
        channelId: callId,
      })
        .then((ch: any) => {
          ariChannel = ch;

          ch.on('ChannelDestroyed', (ev: any) => {
            this.logger.log(`[${ch.id}] Evento: ChannelDestroyed, Causa: ${ev.cause}, Causa Num: ${ev.cause_code}`);
            eventChannelDestroyed = true;
            attemptFinishedAt = new Date(); // ChannelDestroyed es una forma de finalización
            eventCauseCode = ev.cause_code ?? ev.cause ?? -1;
            const currentFlags = this.flags.get(ch.id) || { contactId, rang: false, up: false };
            resolveOnce(this.interpret(eventCauseCode, currentFlags.up));
          });

          ch.on('ChannelStateChange', (_ev: any, channelState: { id: string, state: string }) => {
            if (channelState.id !== ch.id) return;
            this.logger.log(`[${ch.id}] Evento: ChannelStateChange, Nuevo Estado: ${channelState.state}`);
            const f = this.flags.get(ch.id);
            if (f) {
              if (channelState.state === 'Ringing') f.rang = true;
              if (channelState.state === 'Up') {
                if (f.up) return;
                f.up = true;
                if (!attemptAnsweredAt) attemptAnsweredAt = new Date(); // Marcar la hora de contestación
                this.logger.log(`[${ch.id}] Llamada contestada (${attemptAnsweredAt.toISOString()}). Reproduciendo audio: ${audio}`);
                ch.play({ media: `sound:campanas/${audio}` }, (err: any, playback: any) => {
                  if (err) {
                    this.logger.error(`[${ch.id}] Error al iniciar playback: ${err.message}`);
                    ch.hangup().catch((hangupErr: any) => this.logger.error(`[${ch.id}] Error al colgar tras fallo de playback: ${hangupErr.message}`));
                    return;
                  }
                  playback.once('PlaybackFinished', () => {
                    this.logger.log(`[${ch.id}] Playback finalizado. Colgando.`);
                    ch.hangup().catch((hangupErr: any) => this.logger.error(`[${ch.id}] Error al colgar tras PlaybackFinished: ${hangupErr.message}`));
                  });
                });
              }
            }
          });
        })
        .catch((err: any) => {
          this.logger.error(`[${callId}] Error al originar la llamada: ${err.message}`);
          attemptFinishedAt = new Date(); // Falla al originar es una forma de finalización
          resolveOnce({ success: false, causeNum: 'FAIL_ORIGINATE', causeMsg: `Error originando: ${err.message}` });
        });
    });
  }

  private interpret(cause: number, up: boolean, isTimeout: boolean = false): Omit<CallResult, 'startedAt' | 'answeredAt' | 'finishedAt'> {
    if (isTimeout) {
      if (!up && cause === -1) {
        return { success: false, causeNum: '19', causeMsg: CAUSES[19] || 'No contestó (Timeout)' };
      }
      if (up && cause === 16) {
        return { success: true, causeNum: '16', causeMsg: 'Llamada contestada' };
      }
      if (up && cause === -1) {
        return { success: false, causeNum: '-1', causeMsg: 'Llamada contestada pero finalizó por timeout sin causa Asterisk' };
      }
    }

    if (cause === 16 && up) {
      return { success: true, causeNum: '16', causeMsg: 'Llamada contestada' };
    }
    if (cause === 16 && !up) {
      return { success: false, causeNum: '16', causeMsg: CAUSES[19] || 'No contestó' };
    }

    const msg = CAUSES[cause] ?? `Fallo desconocido (Causa ${cause})`;
    return { success: false, causeNum: cause >= 0 ? `${cause}` : String(cause), causeMsg: msg };
  }

  private async generateTts(text: string): Promise<string | null> {
    const form = new FormData(); form.append('text', text);
    try {
      const { data } = await lastValueFrom(
        this.http.post<{ filename: string }>(
          this.configService.get<string>('TTS_URL'), // Leer desde .env
          form,
          { headers: form.getHeaders() },
        ),
      );
      return data.filename?.replace(/\.gsm$/, '') || null;
    } catch (e: any) {
      this.logger.error(`TTS error: ${e.message}`);
      return null;
    }
  }

  private async persist(
    id: string,
    status: 'CALLING' | 'SUCCESS' | 'FAILED',
    num: string,
    msg: string,
    startedAt?: Date | null,
    answeredAt?: Date | null,
    finishedAt?: Date | null,
  ) {
    if (!id) return;
    try {
      await this.campaigns.updateContactStatusById(id, status, num, msg, startedAt, answeredAt, finishedAt);
    }
    catch (e: any) { this.logger.error(`Persist fail for contact ${id}: ${e.message}`); }
  }

  async updateContactStatusById(
    id: string,
    s: string,
    n?: string,
    m?: string,
    startedAt?: Date | null, // Estos vienen de CampaignService si llama a este método directamente
    answeredAt?: Date | null,
    finishedAt?: Date | null
  ) {
    // Este método es expuesto y puede ser llamado por CampaignService.
    // La lógica principal de timestamps se maneja en el `persist` interno
    // cuando AmiService origina la llamada. Si CampaignService necesita
    // actualizar timestamps por otra razón, este método lo permite.
    return this.campaigns.updateContactStatusById(id, s, n, m, startedAt, answeredAt, finishedAt);
  }
}