// src/campaign/dto/update-campaign.dto.ts
import { IsString, IsOptional, IsInt, Min, Max, IsBoolean } from 'class-validator'; // Ya no se necesita IsDateString

export class UpdateCampaignDto {
    @IsOptional()
    @IsString()
    name?: string;

    // 👇 CAMBIO AQUÍ 👇
    @IsOptional()
    @IsString() // Se cambió de IsDateString a IsString
    startDate?: string;

    // 👇 Y CAMBIO AQUÍ 👇
    @IsOptional()
    @IsString() // Se cambió de IsDateString a IsString
    endDate?: string;

    @IsOptional()
    @IsInt()
    @Min(0)
    maxRetries?: number;

    @IsOptional()
    @IsInt()
    @Min(1)
    concurrentCalls?: number;

    @IsBoolean()
    @IsOptional()
    retryOnAnswer?: boolean;
}