import { Controller, Get, Put, Body, UseGuards } from '@nestjs/common';
import { WhatsappCampaignService } from './whatsapp-campaign.service';
// CORRECCIÓN 1: Importamos AuthGuard de passport en lugar del archivo incorrecto
import { AuthGuard } from '@nestjs/passport'; 
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { UpdateWhatsappConfigDto } from './dto/whatsapp-config.dto';

@Controller('whatsapp-config')
// CORRECCIÓN 2: Usamos 'jwt' como estrategia, igual que en tu UserController
@UseGuards(AuthGuard('jwt'), RolesGuard) 
export class WhatsappConfigController {
    constructor(private readonly whatsappService: WhatsappCampaignService) {}

    @Get()
    @Roles('ADMIN') 
    async getConfig() {
        return this.whatsappService.getOrInitConfig();
    }

    @Put()
    @Roles('ADMIN') 
    async updateConfig(@Body() updateDto: UpdateWhatsappConfigDto) {
        return this.whatsappService.updateConfig(updateDto);
    }
}