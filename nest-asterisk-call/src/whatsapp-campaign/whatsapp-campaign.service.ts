import { Injectable, BadRequestException, NotFoundException, Inject, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { ClientProxy } from '@nestjs/microservices';
import { WhatsappCampaign } from './whatsapp-campaign.entity';
import { WhatsappContact } from './whatsapp-contact.entity';
import { WhatsappConfig } from './whatsapp-config.entity';
import { User } from '../user/user.entity';
import * as ExcelJS from 'exceljs';
import * as fs from 'fs';
import dayjs from 'dayjs';
import isBetween from 'dayjs/plugin/isBetween';
import customParseFormat from 'dayjs/plugin/customParseFormat';

dayjs.extend(isBetween);
dayjs.extend(customParseFormat);

@Injectable()
export class WhatsappCampaignService {
    private readonly logger = new Logger(WhatsappCampaignService.name);
    // Semáforo para evitar ejecuciones superpuestas del cron
    private isProcessingQueue = false;

    constructor(
        @InjectRepository(WhatsappCampaign)
        private readonly campaignRepo: Repository<WhatsappCampaign>,
        @InjectRepository(WhatsappContact)
        private readonly contactRepo: Repository<WhatsappContact>,
        @InjectRepository(User)
        private readonly userRepo: Repository<User>,
        @InjectRepository(WhatsappConfig)
        private readonly configRepo: Repository<WhatsappConfig>,
        @Inject('WHATSAPP_SERVICE_CLIENT') private redisClient: ClientProxy,
    ) { }

    // =================================================================
    // 1. HERRAMIENTAS DE SIMULACIÓN HUMANA Y TEXTO
    // =================================================================

    private sleep(ms: number) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    private randomInt(min: number, max: number) {
        return Math.floor(Math.random() * (max - min + 1) + min);
    }

    // SPINTAX: Convierte "{Hola|Qué tal} amigo" -> "Hola amigo" (Aleatorio)
    private spinText(text: string): string {
        if (!text) return '';
        return text.replace(/\{([^{}]+)\}/g, (match, content) => {
            const choices = content.split('|');
            return choices[Math.floor(Math.random() * choices.length)];
        });
    }

    // VARIABLES DINÁMICAS: Reemplaza {{deuda}} por el valor del Excel
    private replaceVariables(text: string, variables: Record<string, any>): string {
        if (!text) return '';
        return text.replace(/\{\{([^}]+)\}\}/g, (match, variableName) => {
            const key = variableName.trim().toLowerCase();
            return variables[key] !== undefined ? variables[key] : match;
        });
    }

    // =================================================================
    // 2. GESTIÓN DE CONFIGURACIÓN GLOBAL
    // =================================================================

    async getOrInitConfig(): Promise<WhatsappConfig> {
        let config = await this.configRepo.findOne({ where: {} });
        if (!config) {
            config = this.configRepo.create({
                creationStartTime: '08:00',
                creationEndTime: '18:00',
                sendingStartTime: '08:00',
                sendingEndTime: '20:00',
                maxCampaignsPerUserPerDay: 5,
                maxContactsPerUserPerDay: 1000,
                minDelaySeconds: 15,
                maxDelaySeconds: 60
            });
            await this.configRepo.save(config);
        }
        return config;
    }

    async updateConfig(dto: any): Promise<WhatsappConfig> {
        const config = await this.getOrInitConfig();
        Object.assign(config, dto);
        return this.configRepo.save(config);
    }

    // =================================================================
    // 3. CREACIÓN DE CAMPAÑA DESDE EXCEL (Con Validaciones)
    // =================================================================

    async createCampaignFromExcel(
        userId: string,
        campaignData: { name: string; messageBody: string; sendDate: Date },
        filePath: string
    ): Promise<WhatsappCampaign> {
        
        // A. Cargar Configuración
        let config = await this.configRepo.findOne({ where: {} });
        if (!config) config = await this.getOrInitConfig();

        const now = dayjs();
        const todayStart = now.startOf('day').toDate();
        const todayEnd = now.endOf('day').toDate();

        // B. Validar Horario de Creación
        const startCreation = dayjs(now.format('YYYY-MM-DD') + ' ' + config.creationStartTime);
        const endCreation = dayjs(now.format('YYYY-MM-DD') + ' ' + config.creationEndTime);

        if (!now.isBetween(startCreation, endCreation)) {
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            throw new BadRequestException(
                `Horario de creación permitido: ${config.creationStartTime} a ${config.creationEndTime}.`
            );
        }

        // C. Validar Límite de Campañas Diarias
        const campaignsToday = await this.campaignRepo.count({
            where: { createdBy: { id: userId }, createdAt: Between(todayStart, todayEnd) }
        });

        if (campaignsToday >= config.maxCampaignsPerUserPerDay) {
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            throw new BadRequestException(`Has alcanzado tu límite diario de ${config.maxCampaignsPerUserPerDay} campañas.`);
        }

        // D. Procesar Excel
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(filePath);
        const worksheet = workbook.getWorksheet(1);
        
        // Leer Encabezados (Fila 1) para Variables Dinámicas
        const headers: string[] = [];
        const headerRow = worksheet.getRow(1);
        headerRow.eachCell((cell, colNumber) => {
            headers[colNumber] = cell.value?.toString().trim().toLowerCase() || '';
        });

        let contactsCount = 0;
        const contactsToCreateData: { phone: string; name: string; message: string }[] = [];

        worksheet.eachRow((row, rowNumber) => {
            if (rowNumber > 1) { // Omitir encabezados
                const phone = row.getCell(1).value?.toString() || '';
                
                if (phone) {
                    // Extraer variables de la fila actual
                    const rowData: Record<string, string> = {};
                    row.eachCell((cell, colNumber) => {
                        const header = headers[colNumber];
                        if (header) {
                            rowData[header] = cell.value?.toString() || '';
                        }
                    });

                    // Intentar obtener el nombre
                    const name = rowData['nombre'] || rowData['name'] || rowData['cliente'] || 'Cliente';

                    // Personalizar el mensaje (Reemplazar {{deuda}}, {{nombre}}, etc.)
                    const customizedMessage = this.replaceVariables(campaignData.messageBody, rowData);

                    contactsCount++;
                    contactsToCreateData.push({ 
                        phone, 
                        name, 
                        message: customizedMessage // Guardamos el mensaje ya personalizado
                    });
                }
            }
        });

        if (contactsCount === 0) {
            fs.unlinkSync(filePath);
            throw new BadRequestException('El archivo Excel no contiene contactos válidos (Columna 1 vacía).');
        }

        // E. Validar Límite de Contactos Diarios
        const { totalContactsToday } = await this.contactRepo.createQueryBuilder('contact')
            .leftJoin('contact.campaign', 'campaign')
            .select('COUNT(contact.id)', 'total')
            .where('campaign.createdBy = :userId', { userId })
            .andWhere('campaign.createdAt BETWEEN :start AND :end', { start: todayStart, end: todayEnd })
            .getRawOne();
        
        const currentTotal = Number(totalContactsToday) || 0;

        if ((currentTotal + contactsCount) > config.maxContactsPerUserPerDay) {
            fs.unlinkSync(filePath);
            throw new BadRequestException(
                `Excederías tu límite diario de ${config.maxContactsPerUserPerDay} contactos. Llevas ${currentTotal}.`
            );
        }

        // F. Guardar en Base de Datos
        const user = await this.userRepo.findOneBy({ id: userId });
        if (!user) {
            fs.unlinkSync(filePath);
            throw new NotFoundException('Usuario creador no encontrado.');
        }

        const campaign = this.campaignRepo.create({
            name: campaignData.name,
            messageBody: campaignData.messageBody, // Guardamos template original como referencia
            sendDate: campaignData.sendDate,
            status: 'PAUSED',
            createdBy: user,
        });
        const savedCampaign = await this.campaignRepo.save(campaign);

        // Guardar Contactos Personalizados
        const contactEntities = contactsToCreateData.map(c => this.contactRepo.create({
            phone: c.phone,
            name: c.name,
            message: c.message,
            campaign: savedCampaign,
            status: 'PENDING'
        }));

        await this.contactRepo.save(contactEntities);
        this.logger.log(`Campaña "${savedCampaign.name}" creada con ${contactsCount} contactos.`);

        fs.unlinkSync(filePath);
        return savedCampaign;
    }

    // =================================================================
    // 4. MOTOR DE ENVÍO INTELIGENTE (Anti-Ban & Human Behavior)
    // =================================================================

    @Cron('*/1 * * * *') // Ejecutar cada minuto
    async handleScheduledSends() {
        if (this.isProcessingQueue) return; // Respetar semáforo
        this.isProcessingQueue = true;

        try {
            // A. Verificar Horario de Envío
            let config = await this.configRepo.findOne({ where: {} });
            if (!config) { this.isProcessingQueue = false; return; }

            const now = dayjs();
            const startSending = dayjs(now.format('YYYY-MM-DD') + ' ' + config.sendingStartTime);
            const endSending = dayjs(now.format('YYYY-MM-DD') + ' ' + config.sendingEndTime);

            if (!now.isBetween(startSending, endSending)) {
                // Fuera de horario, dormir motor
                this.isProcessingQueue = false;
                return;
            }

            // B. Buscar Campañas Activas
            const activeCampaigns = await this.campaignRepo.find({
                where: { status: 'RUNNING' },
                relations: ['createdBy']
            });

            if (activeCampaigns.length === 0) {
                this.isProcessingQueue = false;
                return;
            }

            // C. Procesar 1 Contacto por Campaña (Round Robin)
            for (const campaign of activeCampaigns) {
                
                // Selección Caótica: Elegir contacto al azar, no secuencial
                const contact = await this.contactRepo.createQueryBuilder('contact')
                    .where('contact.campaignId = :campaignId', { campaignId: campaign.id })
                    .andWhere('contact.status = :status', { status: 'PENDING' })
                    .orderBy('RANDOM()') // PostgreSQL Random
                    .getOne();

                if (!contact) {
                    campaign.status = 'COMPLETED';
                    campaign.finishedAt = new Date();
                    await this.campaignRepo.save(campaign);
                    continue;
                }

                // Marcar como procesando
                await this.contactRepo.update(contact.id, { status: 'PROCESSING' });

                try {
                    // --- SIMULACIÓN HUMANA ---

                    // 1. Spintax Final: Variar saludos o sinónimos {Hola|Qué tal}
                    // (El mensaje ya viene personalizado con variables desde la creación)
                    const finalMessage = this.spinText(contact.message);

                    // 2. Pausa "Pensando" (Aleatorio 2-6s)
                    const thinkTime = this.randomInt(2000, 6000);
                    await this.sleep(thinkTime);

                    // 3. Enviar "Escribiendo..."
                    this.redisClient.emit('send-presence', {
                        userId: campaign.createdBy.id,
                        to: contact.phone,
                        state: 'composing'
                    });

                    // 4. Tiempo de Escritura con "Jitter" (Error humano)
                    const messageLen = finalMessage.length;
                    const baseTime = messageLen * 100; // 100ms por caracter
                    const humanJitter = this.randomInt(-1000, 2000); // Variación de tiempo
                    // Mínimo 4s, Máximo 25s
                    const typingTime = Math.min(25000, Math.max(4000, baseTime + humanJitter));
                    
                    await this.sleep(typingTime);

                    // 5. Enviar Mensaje
                    this.redisClient.emit('send-campaign-message', {
                        userId: campaign.createdBy.id,
                        to: contact.phone,
                        text: finalMessage,
                        contactId: contact.id
                    });

                    // 6. Dejar de Escribir
                    this.redisClient.emit('send-presence', {
                        userId: campaign.createdBy.id,
                        to: contact.phone,
                        state: 'paused'
                    });

                    this.logger.log(`[Human Motor] Enviado a ${contact.phone}. Tiempos: Think=${thinkTime}ms, Type=${typingTime}ms`);

                    // 7. Cooldown de Seguridad (Anti-Ban)
                    const cooldown = this.randomInt(config.minDelaySeconds * 1000, config.maxDelaySeconds * 1000);
                    await this.sleep(cooldown);

                } catch (error) {
                    this.logger.error(`Error enviando a ${contact.phone}: ${error.message}`);
                    await this.contactRepo.update(contact.id, { status: 'FAILED', errorMessage: 'Error Interno' });
                }
            }

        } catch (error) {
            this.logger.error('Error en motor de envíos:', error);
        } finally {
            this.isProcessingQueue = false;
        }
    }

    // =================================================================
    // 5. MÉTODOS ESTÁNDAR (CRUD y Consultas)
    // =================================================================

    async findAllWithStats(user: User): Promise<any[]> {
        const queryOptions: any = { order: { createdAt: 'DESC' }, relations: ['createdBy'] };
        if (user.role !== 'ADMIN' && user.role !== 'SUPERVISOR') {
            queryOptions.where = { createdBy: { id: user.id } };
        }
        const campaigns = await this.campaignRepo.find(queryOptions);
        const campaignsWithStats = [];
        for (const campaign of campaigns) {
            const stats = await this.contactRepo.createQueryBuilder("contact")
                .select("contact.status", "status").addSelect("COUNT(*)::int", "count")
                .where("contact.campaignId = :id", { id: campaign.id }).groupBy("contact.status").getRawMany();
            const statsMap = stats.reduce((acc, item) => {
                acc[item.status.toLowerCase()] = item.count;
                return acc;
            }, {});
            const campaignData = { ...campaign, stats: statsMap, createdByName: campaign.createdBy.username };
            delete campaignData.createdBy.password;
            campaignsWithStats.push(campaignData);
        }
        return campaignsWithStats;
    }

    async getCampaignDetails(campaignId: string): Promise<any> {
        const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
        if (!campaign) throw new NotFoundException('Campaña no encontrada');
        const contacts = await this.contactRepo.find({ where: { campaign: { id: campaignId } } });
        const statsResult = await this.contactRepo.createQueryBuilder("contact")
            .select("contact.status", "status").addSelect("COUNT(*)::int", "count")
            .where("contact.campaignId = :id", { id: campaignId }).groupBy("contact.status").getRawMany();
        const statsMap = statsResult.reduce((acc, item) => {
            acc[item.status.toLowerCase()] = item.count;
            return acc;
        }, { total: contacts.length });
        return { campaign, contacts, stats: statsMap };
    }

    async createCampaign(name: string, sendDate: Date, userId: string): Promise<WhatsappCampaign> {
        const user = await this.userRepo.findOneBy({ id: userId });
        if (!user) throw new NotFoundException('Usuario creador no encontrado.');
        const campaign = this.campaignRepo.create({ name, sendDate, status: 'PAUSED', createdBy: user });
        return this.campaignRepo.save(campaign);
    }

    async addContacts(campaignId: string, contacts: any[]): Promise<{ message: string }> {
        const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
        if (!campaign) throw new NotFoundException('Campaña no encontrada');
        const contactEntities = contacts.map(c => this.contactRepo.create({
            identification: c.identification, name: c.name, phone: c.phone, message: c.message, campaign,
        }));
        await this.contactRepo.save(contactEntities);
        return { message: `${contacts.length} contactos añadidos exitosamente.` };
    }

    async startCampaign(id: string): Promise<WhatsappCampaign> {
        const campaign = await this.campaignRepo.findOneBy({ id });
        if (!campaign) throw new NotFoundException('Campaña no encontrada');
        if (!campaign.startedAt) campaign.startedAt = new Date();
        campaign.status = 'RUNNING';
        this.logger.log(`Campaña ${campaign.name} iniciada manualmente.`);
        return this.campaignRepo.save(campaign);
    }

    async pauseCampaign(id: string): Promise<WhatsappCampaign> {
        const campaign = await this.campaignRepo.findOneBy({ id });
        if (!campaign) throw new NotFoundException('Campaña no encontrada');
        campaign.status = 'PAUSED';
        this.logger.log(`Campaña ${campaign.name} pausada manualmente.`);
        return this.campaignRepo.save(campaign);
    }

    async cancelCampaign(id: string): Promise<WhatsappCampaign> {
        const campaign = await this.campaignRepo.findOneBy({ id });
        if (!campaign) throw new NotFoundException('Campaña no encontrada');
        campaign.status = 'CANCELLED';
        campaign.finishedAt = new Date();
        this.logger.log(`Campaña ${campaign.name} cancelada manualmente.`);
        return this.campaignRepo.save(campaign);
    }

    async updateContactStatus(contactId: string, status: 'SENT' | 'FAILED', errorMessage?: string): Promise<void> {
        await this.contactRepo.update({ id: contactId }, { status, errorMessage: errorMessage || null });
    }
}