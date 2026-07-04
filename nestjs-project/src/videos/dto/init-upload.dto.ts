import { ApiProperty } from '@nestjs/swagger';
import {
  IsInt,
  IsNotEmpty,
  IsPositive,
  IsString,
  MaxLength,
} from 'class-validator';

export class InitUploadDto {
  @ApiProperty({ maxLength: 255, description: 'Video title' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  title: string;

  @ApiProperty({ example: 'video/mp4', description: 'MIME type of the file' })
  @IsString()
  @IsNotEmpty()
  contentType: string;

  @ApiProperty({ description: 'Total file size in bytes (max 10 GB)' })
  @IsInt()
  @IsPositive()
  sizeBytes: number;
}
