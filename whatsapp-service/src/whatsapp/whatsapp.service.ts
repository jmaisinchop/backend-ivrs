import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import makeWASocket, { DisconnectReason, useMultiFileAuthState, Browsers, BaileysEventMap, WASocket } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { EventsGateway } from '../events/events.gateway';
import * as path from 'path';
import * as fs from 'fs';

@Injectable()
export class WhatsappService {
    private readonly logger = new Logger(WhatsappService.name);
    private sessions = new Map<string, WASocket>();
    private qrCodes = new Map<string, string>();
    private connecting = new Set<string>();
    private readonly sessionsDir = path.join(process.cwd(), 'whatsapp-sessions');

    constructor(
        @Inject(forwardRef(() => EventsGateway))
        private readonly eventsGateway: EventsGateway,
    ) {
        if (!fs.existsSync(this.sessionsDir)) {
            fs.mkdirSync(this.sessionsDir, { recursive: true });
        }
    }

    async initializeUserSession(userId: string) {
        if (this.sessions.has(userId) && this.sessions.get(userId)?.ws?.isOpen) {
            return { status: 'connected' };
        }
        if (this.qrCodes.has(userId)) {
            return { status: 'waiting-qr', qr: this.qrCodes.get(userId) };
        }
        if (this.connecting.has(userId)) {
            return { status: 'loading' };
        }
        const sessionDir = path.join(this.sessionsDir, userId);
        if (fs.existsSync(sessionDir)) {
            this.logger.log(`[${userId}] Archivos de sesión encontrados. Intentando reconexión automática...`);
            this.startSession(userId);
            return { status: 'loading' }; 
        }
        return { status: 'disconnected' };
    }

    async startSession(userId: string) {
        if (this.sessions.has(userId) || this.connecting.has(userId)) {
            this.logger.warn(`[${userId}] La conexión ya está activa o en proceso.`);
            return;
        }

        this.connecting.add(userId);
        const sessionDir = path.join(this.sessionsDir, userId);
        this.logger.log(`Iniciando o restaurando sesión de WhatsApp para: ${userId}`);

        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            browser: Browsers.ubuntu('Chrome'),
        });

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            const userSocketEvent = `whatsapp-status-${userId}`;

            if (qr) {
                this.qrCodes.set(userId, qr);
                this.eventsGateway.server.emit(`whatsapp-qr-${userId}`, qr);
                this.eventsGateway.server.emit(userSocketEvent, { status: 'waiting-qr' });
            }

            if (connection === 'close') {
                this.connecting.delete(userId);
                this.sessions.delete(userId);
                this.qrCodes.delete(userId);
                
                const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
                
                if (statusCode === DisconnectReason.restartRequired) {
                    this.logger.log(`[${userId}] Reinicio requerido. Reintentando conexión automáticamente...`);
                    this.startSession(userId);
                    return;
                }

                if (statusCode === DisconnectReason.loggedOut || statusCode === DisconnectReason.connectionReplaced) {
                    this.logger.warn(`[${userId}] Sesión cerrada o reemplazada. Limpiando archivos.`);
                    fs.rm(sessionDir, { recursive: true, force: true }, (err) => {
                        if (err) this.logger.error(`Error borrando sesión de ${userId}: ${err.message}`);
                    });
                }
                
                this.eventsGateway.server.emit(userSocketEvent, { status: 'disconnected' });

            } else if (connection === 'open') {
                this.logger.log(`[${userId}] Conexión de WhatsApp abierta y confirmada.`);
                this.connecting.delete(userId);
                this.sessions.set(userId, sock);
                this.qrCodes.delete(userId);
                this.eventsGateway.server.emit(userSocketEvent, { status: 'connected' });
            }
        });

        sock.ev.on('creds.update', saveCreds);
    }
    
    async sendMessage(userId: string, to: string, text: string) {
        const sock = this.sessions.get(userId);
        if (!sock || !sock.user) {
            throw new Error(`La sesión de WhatsApp para ${userId} no está conectada.`);
        }
        const formattedTo = `${to.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
        await sock.sendMessage(formattedTo, { text });
        return { success: true };
    }
    async sendPresence(userId: string, to: string, state: 'composing' | 'paused') {
        const sock = this.sessions.get(userId);
        if (!sock) return; // Si no hay sesión, ignoramos silenciosamente
        
        const formattedTo = `${to.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
        
        // Función nativa de Baileys para cambiar estado (Escribiendo...)
        await sock.sendPresenceUpdate(state, formattedTo);
    }
}