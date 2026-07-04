import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class UploadPartDto {
  @ApiProperty({ minimum: 1, description: 'Part number (1-based)' })
  @IsInt()
  @Min(1)
  partNumber: number;

  @ApiProperty({ description: 'ETag returned by storage for this part' })
  @IsString()
  @IsNotEmpty()
  etag: string;
}

export class CompleteUploadDto {
  @ApiProperty({
    type: [UploadPartDto],
    description: 'Uploaded parts in order',
  })
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => UploadPartDto)
  parts: UploadPartDto[];
}
