import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video, VideoStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    counter += 1;
    const user = await userRepository.save(
      userRepository.create({
        email: `vid_user_${counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `Channel ${counter}`,
        nickname: `chan_${counter}`,
        user_id: user.id,
      }),
    );
  }

  it('defaults status to DRAFT and views_count to 0', async () => {
    const channel = await createChannel();
    const saved = await videoRepository.save(
      videoRepository.create({
        public_id: 'abc123',
        channel_id: channel.id,
        title: 'My first video',
      }),
    );

    const found = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(found.status).toBe(VideoStatus.DRAFT);
    expect(found.views_count).toBe(0);
  });

  it('enforces the unique public_id constraint', async () => {
    const channel = await createChannel();
    await videoRepository.save(
      videoRepository.create({
        public_id: 'dup-id',
        channel_id: channel.id,
        title: 'First',
      }),
    );

    await expect(
      videoRepository.save(
        videoRepository.create({
          public_id: 'dup-id',
          channel_id: channel.id,
          title: 'Second',
        }),
      ),
    ).rejects.toThrow();
  });

  it('cascade-deletes videos when their channel is removed', async () => {
    const channel = await createChannel();
    const video = await videoRepository.save(
      videoRepository.create({
        public_id: 'cascade-me',
        channel_id: channel.id,
        title: 'Doomed',
      }),
    );

    await channelRepository.delete({ id: channel.id });

    const found = await videoRepository.findOneBy({ id: video.id });
    expect(found).toBeNull();
  });

  it('round-trips bigint size_bytes as a JS number', async () => {
    const channel = await createChannel();
    const tenGb = 10_737_418_240;
    const saved = await videoRepository.save(
      videoRepository.create({
        public_id: 'big-file',
        channel_id: channel.id,
        title: 'Large',
        size_bytes: tenGb,
      }),
    );

    const found = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(found.size_bytes).toBe(tenGb);
  });
});
