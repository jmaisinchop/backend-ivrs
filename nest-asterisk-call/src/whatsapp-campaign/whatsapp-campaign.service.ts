import { Injectable, BadRequestException, NotFoundException, Inject, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { ClientProxy } from '@nestjs/microservices';
import { WhatsappCampaign } from './whatsapp-campaign.entity';
import { WhatsappContact } from './whatsapp-contact.entity';
import { User } from '../user/user.entity';

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

    async createCampaign(name: string, sendDate: Date, userId: string): Promise<WhatsappCampaign> {
        const user = await this.userRepo.findOneBy({ id: userId });
        if (!user) {
            throw new NotFoundException('Usuario creador no encontrado.');
        }

        const sendDateTime = new Date(sendDate);
        if (sendDateTime < new Date()) {
            throw new BadRequestException('La fecha de envío no puede ser en el pasado.');
        }

        const hour = sendDateTime.getHours();
        if (hour < 8 || hour >= 19) {
            throw new BadRequestException('La hora de envío debe estar entre las 08:00 y las 18:59.');
        }

        const campaign = this.campaignRepo.create({ name, sendDate, status: 'PAUSED', createdBy: user });
        return this.campaignRepo.save(campaign);
    }

    async addContacts(campaignId: string, contacts: any[]): Promise<{ message: string }> {
        const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
        if (!campaign) throw new NotFoundException('Campaña no encontrada');

        const totalContacts = await this.contactRepo.count({ where: { campaign: { id: campaignId } } });
        if (totalContacts + contacts.length > 600) {
            throw new BadRequestException(`No se pueden cargar más de 600 contactos. Ya tienes ${totalContacts}.`);
        }
        const contactEntities = contacts.map(c => this.contactRepo.create({
            identification: c.identification, name: c.name, phone: c.phone, message: c.message, campaign,
        }));
        await this.contactRepo.save(contactEntities);
        return { message: `${contacts.length} contactos añadidos exitosamente.` };
    }

    async findAllWithStats(): Promise<any[]> {
        const campaigns = await this.campaignRepo.find({ order: { createdAt: 'DESC' } });
        const campaignsWithStats = [];
        for (const campaign of campaigns) {
            const stats = await this.contactRepo.createQueryBuilder("contact")
                .select("contact.status", "status").addSelect("COUNT(*)::int", "count")
                .where("contact.campaignId = :id", { id: campaign.id }).groupBy("contact.status").getRawMany();
            const statsMap = stats.reduce((acc, item) => {
                acc[item.status.toLowerCase()] = item.count;
                return acc;
            }, {});
            campaignsWithStats.push({ ...campaign, stats: statsMap });
        }
        return campaignsWithStats;
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
        const runningCampaigns = await this.campaignRepo.find({ where: { status: 'RUNNING' } });
        if (runningCampaigns.length === 0) return;
        
        for (const campaign of runningCampaigns) {
            const contact = await this.contactRepo.findOne({
                where: { campaign: { id: campaign.id }, status: 'PENDING' }
            });

            if (contact) {
                const senderUser = campaign.createdBy;
                if (!senderUser || !senderUser.id) {
                    this.logger.error(`La campaña ${campaign.id} no tiene un creador válido.`);
                    continue;
                }

                this.redisClient.emit('send-campaign-message', {
                    userId: senderUser.id,
                    to: contact.phone,
                    text: contact.message,
                    contactId: contact.id,
                });

                contact.status = 'SENDING';
                await this.contactRepo.save(contact);
            } else {
                const pendingCount = await this.contactRepo.count({ where: { campaign: { id: campaign.id }, status: 'PENDING' }});
                const sendingCount = await this.contactRepo.count({ where: { campaign: { id: campaign.id }, status: 'SENDING' }});
                if (pendingCount === 0 && sendingCount === 0) {
                    this.logger.log(`Campaña ${campaign.name} completada.`);
                    campaign.status = 'COMPLETED';
                    campaign.finishedAt = new Date();
                    await this.campaignRepo.save(campaign);
                }
            }
        }
    }

    async updateContactStatus(contactId: string, status: 'SENT' | 'FAILED', errorMessage?: string): Promise<void> {
        await this.contactRepo.update({ id: contactId }, {
            status,
            errorMessage: errorMessage || null
        });
    }
}