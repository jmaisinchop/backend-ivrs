import { Injectable, BadRequestException, NotFoundException, Inject, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { ClientProxy } from '@nestjs/microservices';
import { WhatsappCampaign } from './whatsapp-campaign.entity';
import { WhatsappContact } from './whatsapp-contact.entity';
import { User } from '../user/user.entity';
import * as ExcelJS from 'exceljs';
import * as fs from 'fs';

@Injectable()
export class WhatsappCampaignService {
    private readonly logger = new Logger(WhatsappCampaignService.name);

    constructor(
        @InjectRepository(WhatsappCampaign)
        private readonly campaignRepo: Repository<WhatsappCampaign>,
        @InjectRepository(WhatsappContact)
        private readonly contactRepo: Repository<WhatsappContact>,
        @InjectRepository(User)
        private readonly userRepo: Repository<User>,
        @Inject('WHATSAPP_SERVICE_CLIENT') private redisClient: ClientProxy,
    ) {}

    /**
     * ✅ NUEVO: Crea una campaña, lee un archivo Excel y añade los contactos.
     */
    async createCampaignFromExcel(
        userId: string,
        campaignData: { name: string; messageBody: string; sendDate: Date },
        filePath: string
    ): Promise<WhatsappCampaign> {
        const user = await this.userRepo.findOneBy({ id: userId });
        if (!user) {
            throw new NotFoundException('Usuario creador no encontrado.');
        }

        const campaign = this.campaignRepo.create({
            name: campaignData.name,
            messageBody: campaignData.messageBody,
            sendDate: campaignData.sendDate,
            status: 'PAUSED', // Las campañas siempre inician pausadas
            createdBy: user,
        });
        const savedCampaign = await this.campaignRepo.save(campaign);

        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(filePath);
        const worksheet = workbook.getWorksheet(1);

        const contactsToCreate: Partial<WhatsappContact>[] = [];
        worksheet.eachRow((row, rowNumber) => {
            if (rowNumber > 1) { // Omitir la cabecera
                const phone = row.getCell(1).value?.toString() || '';
                const name = row.getCell(2).value?.toString() || 'Sin Nombre';

                if (phone) {
                    contactsToCreate.push({
                        phone,
                        name,
                        message: campaignData.messageBody,
                        campaign: savedCampaign,
                    });
                }
            }
        });

        if (contactsToCreate.length === 0) {
            fs.unlinkSync(filePath); // Limpiar archivo aunque falle
            throw new BadRequestException('El archivo Excel no contiene contactos válidos.');
        }

        await this.contactRepo.save(contactsToCreate);
        this.logger.log(`Se han añadido ${contactsToCreate.length} contactos a la campaña "${savedCampaign.name}".`);

        fs.unlinkSync(filePath);
        return savedCampaign;
    }

    /**
     * ✅ MEJORADO: Lista campañas filtrando por rol de usuario.
     */
    async findAllWithStats(user: User): Promise<any[]> {
        const queryOptions: any = {
            order: { createdAt: 'DESC' },
            relations: ['createdBy']
        };

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
            
            const campaignData = { 
                ...campaign, 
                stats: statsMap,
                createdByName: campaign.createdBy.username
            };
            delete campaignData.createdBy.password; // Asegurarse de no exponer la contraseña

            campaignsWithStats.push(campaignData);
        }
        return campaignsWithStats;
    }

    /**
     * ✅ NUEVO: Obtiene los detalles y estadísticas de una campaña específica.
     */
    async getCampaignDetails(campaignId: string): Promise<any> {
        const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
        if (!campaign) {
            throw new NotFoundException('Campaña no encontrada');
        }

        const contacts = await this.contactRepo.find({ where: { campaign: { id: campaignId } } });
        
        const statsResult = await this.contactRepo.createQueryBuilder("contact")
            .select("contact.status", "status")
            .addSelect("COUNT(*)::int", "count")
            .where("contact.campaignId = :id", { id: campaignId })
            .groupBy("contact.status")
            .getRawMany();
        
        const statsMap = statsResult.reduce((acc, item) => {
            acc[item.status.toLowerCase()] = item.count;
            return acc;
        }, { total: contacts.length });

        return { campaign, contacts, stats: statsMap };
    }

    // --- MÉTODOS EXISTENTES ---

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
        
        if (!campaign.startedAt) {
            campaign.startedAt = new Date();
        }
        
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
    
    @Cron('*/15 * 8-19 * * 1-5')
    async handleScheduledSends() {
        // Lógica del cron job existente
        // ...
    }

    async updateContactStatus(contactId: string, status: 'SENT' | 'FAILED', errorMessage?: string): Promise<void> {
        await this.contactRepo.update({ id: contactId }, {
            status,
            errorMessage: errorMessage || null
        });
    }
}