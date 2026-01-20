import { Req, Controller, Post, Body, Param, Get, Query, UseGuards, UsePipes, ValidationPipe, ParseIntPipe, Patch } from '@nestjs/common';
import { CampaignService } from './campaign.service';
import { AuthGuard } from '@nestjs/passport';
import { UpdateCampaignDto } from './dto/update-campaign.dto';
import { DuplicateCampaignDto } from './dto/duplicate-campaign.dto';
import { CreateCampaignDto } from './dto/create-campaign.dto';
import { PermissionGuard, RequirePermission } from '../auth/permissions.guard';
import { Roles } from 'src/auth/roles.decorator';
import { RolesGuard } from 'src/auth/roles.guard';
import { AmiService } from '../ami/ami.service'; 


@UseGuards(AuthGuard('jwt'), PermissionGuard) 
@RequirePermission('ivrs')
@Controller('campaigns')
export class CampaignController {
  constructor(private readonly campaignService: CampaignService, private readonly amiService: AmiService,
  ) { }

  @Post()
  @Post()
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  async createCampaign(
    @Body() createCampaignDto: CreateCampaignDto, 
    @Req() req
  ) {
    const userId = req.user.id;
    return this.campaignService.createCampaign(userId, createCampaignDto);
  }

  @Post(':id/contacts')
  async addContacts(
    @Param('id') campaignId: string,
    @Body()
    body: { contacts: { name: string; phone: string; message: string, identification: string }[] },
  ) {
    const result = await this.campaignService.addContactsToCampaign(
      campaignId,
      body.contacts,
    );
    return {
      message: `Contactos agregados a la campaña ${campaignId}`,
      result,
    };
  }

  @Post(':id/duplicate')
  @UsePipes(new ValidationPipe({ whitelist: true }))
  async duplicateCampaign(
    @Req() req,
    @Param('id') originalCampaignId: string,
    @Body() dto: DuplicateCampaignDto,
  ) {
    const userId = req.user.id;
    return this.campaignService.duplicateCampaign(originalCampaignId, userId, dto);
  }

  @Post(':id/start')
  async startCampaign(@Param('id') campaignId: string) {
    const result = await this.campaignService.startCampaign(campaignId);
    return { message: result };
  }

  // Pausar
  @Post(':id/pause')
  async pauseCampaign(@Param('id') campaignId: string) {
    const result = await this.campaignService.pauseCampaign(campaignId);
    return { message: result };
  }

  // Cancelar
  @Post(':id/cancel')
  async cancelCampaign(@Param('id') campaignId: string) {
    const result = await this.campaignService.cancelCampaign(campaignId);
    return { message: result };
  }

  @Get(':id')
  async getCampaign(@Param('id') campaignId: string) {
    const camp = await this.campaignService.getCampaignById(campaignId);
    if (!camp) return { message: 'Campaña no encontrada' };
    return camp;
  }

  @Get('all/minimal')
  async getAllCampaigns(@Req() req) {
    const userId = req.user.id;
    const role = req.user.role;
    return this.campaignService.getAllCampaignsMinimal(userId, role);
  }


  @Get('summary/active')
  getActiveCampaigns(@Query('range') range = 'month') {
    return this.campaignService
      .getActiveCampaignCount(range)
      .then((total) => ({ total }));
  }

  @Get('summary/ongoing')
  getOngoingCalls(@Query('range') range = 'month') {
    return this.campaignService
      .getOngoingCallCount(range)
      .then((total) => ({ total }));
  }

  @Get('summary/success-rate')
  getSuccessRate(@Query('range') range = 'month') {
    return this.campaignService
      .getSuccessRate(range)
      .then((successRate) => ({ successRate }));
  }

  @Get('summary/contacts')
  getTotalContacts(@Query('range') range = 'month') {
    return this.campaignService
      .getTotalContacts(range)
      .then((total) => ({ total }));
  }

  @Get('stats/calls-per-month')
  getCallsPerMonth(@Query('range') range = 'month') {
    return this.campaignService.getMonthlyCallStats(range);
  }

  @Get('stats/call-status-distribution')
  getCallStatusDist(@Query('range') range = 'month') {
    return this.campaignService.getCallStatusDistribution(range);
  }
  @Get(':id/contacts/live')
  async liveContacts(
    @Param('id') id: string,
    @Query('status') status = 'ALL',
    @Query('limit') limit = '50',
    @Query('offset') offset = '0',
  ) {
    return this.campaignService.getLiveContacts(
      id,
      status.toUpperCase(),
      +limit,
      +offset,
    );
  }

  @Get(':id/contacts/pages')
  async pages(
    @Param('id') id: string,
    @Query('status') status = 'ALL',
    @Query('limit') limit = '50',
  ) {
    return this.campaignService.getPages(id, status.toUpperCase(), +limit);
  }

  @Get(':id/contacts')
  async getCampaignContacts(@Param('id') id: string) {
    return this.campaignService.getCampaignContacts(id);
  }

  @Patch(':id')
  @UsePipes(new ValidationPipe({ whitelist: true })) 
  async updateCampaign(
    @Param('id') campaignId: string,
    @Body() updateDto: UpdateCampaignDto,
  ) {
    return this.campaignService.updateCampaign(campaignId, updateDto);
  }

  @Post('contacts/:contactId/spy')
  async spyOnCall(
    @Param('contactId') contactId: string,
    @Req() req,
  ) {
    const supervisorExtension = req.user.extension;
    if (!supervisorExtension) {
      throw new Error('El perfil del supervisor no tiene una extensión configurada.');
    }
    return this.amiService.spyCall(contactId, supervisorExtension);
  }
}
