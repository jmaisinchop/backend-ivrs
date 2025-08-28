import { Controller, Post, Body, Param, Get, UseGuards, ParseUUIDPipe, Req } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { WhatsappCampaignService } from './whatsapp-campaign.service';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { InternalApiGuard } from '../auth/internal-api.guard';

class CreateWhatsappCampaignDto {
    name: string;
    sendDate: Date;
}

class AddContactsDto {
    contacts: {
        identification?: string;
        name: string;
        phone: string;
        message: string;
    }[];
}

class UpdateStatusDto {
    status: 'SENT' | 'FAILED';
    errorMessage?: string;
}

@Controller('whatsapp-campaigns')
export class WhatsappCampaignController {
    constructor(private readonly campaignService: WhatsappCampaignService) {}

    @Post()
    @UseGuards(AuthGuard('jwt'), RolesGuard)
    @Roles('ADMIN', 'SUPERVISOR', 'CALLCENTER')
    createCampaign(@Body() createDto: CreateWhatsappCampaignDto, @Req() req) {
        const userId = req.user.id;
        return this.campaignService.createCampaign(createDto.name, createDto.sendDate, userId);
    }

    @Post(':id/contacts')
    @UseGuards(AuthGuard('jwt'), RolesGuard)
    @Roles('ADMIN', 'SUPERVISOR', 'CALLCENTER')
    addContacts(@Param('id', ParseUUIDPipe) id: string, @Body() addContactsDto: AddContactsDto) {
        return this.campaignService.addContacts(id, addContactsDto.contacts);
    }

    @Get()
    @UseGuards(AuthGuard('jwt'), RolesGuard)
    @Roles('ADMIN', 'SUPERVISOR', 'CALLCENTER')
    findAll() {
        return this.campaignService.findAllWithStats();
    }
    
    @Post(':id/start')
    @UseGuards(AuthGuard('jwt'), RolesGuard)
    @Roles('ADMIN', 'SUPERVISOR', 'CALLCENTER')
    startCampaign(@Param('id', ParseUUIDPipe) id: string) {
        return this.campaignService.startCampaign(id);
    }

    @Post(':id/pause')
    @UseGuards(AuthGuard('jwt'), RolesGuard)
    @Roles('ADMIN', 'SUPERVISOR', 'CALLCENTER')
    pauseCampaign(@Param('id', ParseUUIDPipe) id: string) {
        return this.campaignService.pauseCampaign(id);
    }

    @Post(':id/cancel')
    @UseGuards(AuthGuard('jwt'), RolesGuard)
    @Roles('ADMIN', 'SUPERVISOR', 'CALLCENTER')
    cancelCampaign(@Param('id', ParseUUIDPipe) id: string) {
        return this.campaignService.cancelCampaign(id);
    }

    @Post('contacts/:id/status')
    @UseGuards(InternalApiGuard) // <-- Usa el nuevo guard
    updateStatus(@Param('id', ParseUUIDPipe) id: string, @Body() updateStatusDto: UpdateStatusDto) {
        return this.campaignService.updateContactStatus(id, updateStatusDto.status, updateStatusDto.errorMessage);
    }
}