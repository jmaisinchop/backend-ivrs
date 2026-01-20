// Si no tienes class-validator instalado, instálalo: npm install class-validator class-transformer
import { IsString, IsNumber, IsOptional, Matches, Min, Max } from 'class-validator';

export class UpdateWhatsappConfigDto {
    @IsOptional()
    @IsString()
    @Matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, { message: 'El formato de hora debe ser HH:mm' })
    creationStartTime?: string;

    @IsOptional()
    @IsString()
    @Matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, { message: 'El formato de hora debe ser HH:mm' })
    creationEndTime?: string;

    @IsOptional()
    @IsString()
    @Matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, { message: 'El formato de hora debe ser HH:mm' })
    sendingStartTime?: string;

    @IsOptional()
    @IsString()
    @Matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, { message: 'El formato de hora debe ser HH:mm' })
    sendingEndTime?: string;

    @IsOptional()
    @IsNumber()
    @Min(1)
    maxCampaignsPerUserPerDay?: number;

    @IsOptional()
    @IsNumber()
    @Min(1)
    maxContactsPerUserPerDay?: number;

    @IsOptional()
    @IsNumber()
    @Min(1)
    minDelaySeconds?: number;

    @IsOptional()
    @IsNumber()
    @Min(1)
    maxDelaySeconds?: number;
}