import {
  Controller,
  Post,
  Body,
  Param,
  Get,
  UseGuards,
  ParseUUIDPipe,
  Req,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname } from 'path';

import { AuthGuard } from '@nestjs/passport';
import { WhatsappCampaignService } from './whatsapp-campaign.service';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { InternalApiGuard } from '../auth/internal-api.guard';
import { User } from '../user/user.entity';


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


  @Post('create-with-file')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('ADMIN', 'SUPERVISOR', 'CALLCENTER')
  @UseInterceptors(FileInterceptor('contactsFile', {
    storage: diskStorage({
      destination: './uploads', 
      filename: (req, file, cb) => {
        const randomName = Array(32).fill(null).map(() => (Math.round(Math.random() * 16)).toString(16)).join('');
        cb(null, `${randomName}${extname(file.originalname)}`);
      },
    }),
    fileFilter: (req, file, cb) => {
      if (!file.originalname.match(/\.(xlsx|xls)$/)) {
        return cb(new BadRequestException('Solo se permiten archivos Excel (.xlsx, .xls)'), false);
      }
      cb(null, true);
    },
  }))
  createWithFile(
    @UploadedFile() file: Express.Multer.File,
    @Body() body: { name: string; messageBody: string; sendDate: Date },
    @Req() req,
  ) {
    if (!file) {
      throw new BadRequestException('El archivo de contactos es obligatorio.');
    }
    const userId = req.user.id;
    return this.campaignService.createCampaignFromExcel(userId, body, file.path);
  }


  @Get()
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('ADMIN', 'SUPERVISOR', 'CALLCENTER')
  findAll(@Req() req) {
    return this.campaignService.findAllWithStats(req.user as User);
  }
  

  @Get(':id/details')
  @UseGuards(AuthGuard('jwt'))
  getCampaignDetails(@Param('id', ParseUUIDPipe) id: string) {
      return this.campaignService.getCampaignDetails(id);
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
  @UseGuards(InternalApiGuard) // Protegido con una clave secreta de API
  updateStatus(@Param('id', ParseUUIDPipe) id: string, @Body() updateStatusDto: UpdateStatusDto) {
    return this.campaignService.updateContactStatus(id, updateStatusDto.status, updateStatusDto.errorMessage);
  }


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
}