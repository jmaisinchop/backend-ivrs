import {
  Controller,
  Post,
  Body,
  Get,
  UseGuards,
  Put,
  Param,
  ParseUUIDPipe,
  ValidationPipe,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { UserService } from './user.service';
import { User } from './user.entity';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { UpdateUserDto } from './dto/update-user.dto';

@Controller('users')
export class UserController {
  constructor(private readonly userService: UserService) {}

  /**
   * Crea un nuevo usuario.
   */
  @Post()
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('ADMIN') // Solo los administradores pueden crear usuarios
  createUser(@Body() body: Partial<User>) {
    return this.userService.create(body);
  }

  /**
   * Obtiene la lista de todos los usuarios.
   */
  @Get()
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('ADMIN', 'SUPERVISOR') // Solo admins y supervisores pueden ver la lista
  getAll() {
    return this.userService.getAll();
  }

  /**
   * Actualiza la contraseña de un usuario específico.
   */
  @Put('update-password')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('ADMIN', 'SUPERVISOR')
  async updatePassword(
    @Body() body: { userId: string; newPassword: string },
  ) {
    return this.userService.updatePassword(body.userId, body.newPassword);
  }

  /**
   * Actualiza los datos de un usuario (nombre, rol, permisos, etc.).
   */
  @Put(':id')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('ADMIN', 'SUPERVISOR')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(ValidationPipe) updateUserDto: UpdateUserDto,
  ) {
    return this.userService.update(id, updateUserDto);
  }
}