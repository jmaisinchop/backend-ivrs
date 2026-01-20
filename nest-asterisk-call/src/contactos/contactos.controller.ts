import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ContactosService } from './contactos.service';
import { AuthGuard } from '@nestjs/passport';
@UseGuards(AuthGuard('jwt'))
@Controller('contactos')
export class ContactosController {
  constructor(private readonly contactosService: ContactosService) {}

  @Get('padres-niveles')
  async obtenerPadresNiveles() {
    return this.contactosService.obtenerPadresNiveles();
  }
  @Post('contactosnivel')
  async obtenerContactosPorNivel(
    @Body() body: { niveles: string; esPropia: boolean },
  ) {
    const { niveles, esPropia } = body;
    return this.contactosService.obtenerContactosPorNivel(niveles, esPropia);
  }
}
