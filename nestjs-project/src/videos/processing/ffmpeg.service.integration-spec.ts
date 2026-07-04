import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { FfmpegService } from './ffmpeg.service';

const execFileAsync = promisify(execFile);

describe('FfmpegService (integration)', () => {
  const service = new FfmpegService();
  let workDir: string;
  let fixturePath: string;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'ffmpeg-spec-'));
    fixturePath = join(workDir, 'fixture.mp4');
    // Generate a deterministic 2s / 320x240 test video with ffmpeg's lavfi source.
    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=2:size=320x240:rate=10',
      '-pix_fmt',
      'yuv420p',
      fixturePath,
    ]);
  });

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('extracts duration and dimensions via ffprobe', async () => {
    const metadata = await service.probe(fixturePath);

    expect(metadata.durationSeconds).toBe(2);
    expect(metadata.width).toBe(320);
    expect(metadata.height).toBe(240);
  });

  it('extracts a thumbnail frame via ffmpeg', async () => {
    const outputPath = join(workDir, 'thumb.jpg');

    await service.extractThumbnail(fixturePath, outputPath, 1);

    const info = await stat(outputPath);
    expect(info.size).toBeGreaterThan(0);
  });
});
