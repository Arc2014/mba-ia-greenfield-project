import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Injectable } from '@nestjs/common';

const execFileAsync = promisify(execFile);

export interface VideoMetadata {
  durationSeconds: number;
  width: number | null;
  height: number | null;
}

/**
 * Thin wrapper over the `ffprobe`/`ffmpeg` system binaries (per phase-03 TD-05 —
 * `fluent-ffmpeg` was archived, so we shell out directly via `child_process`).
 * `execFile` (no shell) avoids argument-injection from untrusted paths.
 */
@Injectable()
export class FfmpegService {
  /** Extracts duration (seconds) and frame dimensions from a media file. */
  async probe(filePath: string): Promise<VideoMetadata> {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      filePath,
    ]);

    const parsed = JSON.parse(stdout) as {
      format?: { duration?: string };
      streams?: { codec_type?: string; width?: number; height?: number }[];
    };
    const videoStream = parsed.streams?.find(
      (stream) => stream.codec_type === 'video',
    );
    const duration = Number(parsed.format?.duration ?? 0);

    return {
      durationSeconds: Number.isFinite(duration) ? Math.round(duration) : 0,
      width: videoStream?.width ?? null,
      height: videoStream?.height ?? null,
    };
  }

  /** Extracts a single frame at `atSeconds` and writes it as a JPEG thumbnail. */
  async extractThumbnail(
    filePath: string,
    outputPath: string,
    atSeconds = 0,
  ): Promise<void> {
    await execFileAsync('ffmpeg', [
      '-y',
      '-ss',
      String(atSeconds),
      '-i',
      filePath,
      '-frames:v',
      '1',
      '-q:v',
      '2',
      outputPath,
    ]);
  }
}
