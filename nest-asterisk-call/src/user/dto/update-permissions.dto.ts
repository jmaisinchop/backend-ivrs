import { IsBoolean, IsNotEmpty } from 'class-validator';

export class UpdatePermissionsDto {
  @IsBoolean()
  @IsNotEmpty()
  canAccessIvrs: boolean;

  @IsBoolean()
  @IsNotEmpty()
  canAccessWhatsapp: boolean;
}