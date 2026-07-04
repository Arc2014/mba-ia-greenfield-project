import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Redirect,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { InitUploadDto } from './dto/init-upload.dto';
import type {
  CompleteUploadResult,
  InitUploadResult,
  WatchInfo,
} from './videos.service';
import { VideosService } from './videos.service';

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Initiate a video upload',
    description:
      'Pre-registers the video as a draft, opens a multipart upload and returns presigned part URLs.',
  })
  @ApiResponse({
    status: 201,
    description: 'Upload initiated',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        publicId: { type: 'string' },
        status: { type: 'string', example: 'DRAFT' },
        uploadId: { type: 'string' },
        partSize: { type: 'integer' },
        parts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              partNumber: { type: 'integer' },
              url: { type: 'string' },
            },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 413,
    description: 'File exceeds the maximum allowed size',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 415,
    description: 'Unsupported media type',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async initUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: InitUploadDto,
  ): Promise<InitUploadResult> {
    return this.videosService.initUpload(user.sub, dto);
  }

  @Post(':id/complete')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Complete a video upload',
    description:
      'Finishes the multipart upload, transitions the video to PROCESSING and enqueues processing.',
  })
  @ApiResponse({
    status: 200,
    description: 'Upload completed; processing enqueued',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        publicId: { type: 'string' },
        status: { type: 'string', example: 'PROCESSING' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'Video does not belong to your channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Upload is not in a draft state',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<CompleteUploadResult> {
    return this.videosService.completeUpload(user.sub, id, dto);
  }

  @Public()
  @UseGuards(OptionalJwtAuthGuard)
  @Get(':publicId')
  @ApiOperation({
    summary: 'Get video metadata',
    description:
      'Returns processing status and metadata. Anonymous callers only see READY videos; the owner sees any status.',
  })
  @ApiResponse({
    status: 200,
    description: 'Video metadata',
    schema: {
      properties: {
        publicId: { type: 'string' },
        title: { type: 'string' },
        status: { type: 'string', example: 'READY' },
        durationSeconds: { type: 'integer', nullable: true },
        width: { type: 'integer', nullable: true },
        height: { type: 'integer', nullable: true },
        thumbnailUrl: { type: 'string', nullable: true },
        viewsCount: { type: 'integer' },
      },
    },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found (or not yet READY for an anonymous caller)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getWatchInfo(
    @Param('publicId') publicId: string,
    @CurrentUser() user: JwtPayload | undefined,
  ): Promise<WatchInfo> {
    return this.videosService.getWatchInfo(publicId, user?.sub);
  }

  @Public()
  @Get(':publicId/stream')
  @Redirect()
  @ApiOperation({
    summary: 'Stream a video',
    description:
      'Redirects (302) to a short-lived presigned GET URL; storage serves Range/206. Increments the view count.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to the presigned stream URL',
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready for playback',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async stream(
    @Param('publicId') publicId: string,
  ): Promise<{ url: string; statusCode: number }> {
    const url = await this.videosService.getStreamRedirect(publicId);
    return { url, statusCode: HttpStatus.FOUND };
  }

  @Public()
  @Get(':publicId/download')
  @Redirect()
  @ApiOperation({
    summary: 'Download a video',
    description:
      'Redirects (302) to a presigned GET URL that forces an attachment download.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to the presigned download URL',
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready for playback',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async download(
    @Param('publicId') publicId: string,
  ): Promise<{ url: string; statusCode: number }> {
    const url = await this.videosService.getDownloadRedirect(publicId);
    return { url, statusCode: HttpStatus.FOUND };
  }
}
