import 'package:buzz/features/channels/channel_mutes/channel_mutes_storage.dart'
    as mutes;
import 'package:buzz/features/channels/channel_stars/channel_stars_storage.dart'
    as stars;
import 'package:flutter_test/flutter_test.dart';

/// The keys, tags and fields below are persisted on every user's devices and
/// relay. Changing any of them silently orphans existing preferences.
void main() {
  test('mute and star flags keep their storage keys', () {
    expect(mutes.channelMutesKey('pk'), 'buzz.channel-mutes.v1:pk');
    expect(stars.channelStarsKey('pk'), 'buzz.channel-stars.v1:pk');
  });

  test('mute and star flags keep their relay wire format', () {
    expect(
      (mutes.channelMutesSpec.dTag, mutes.channelMutesSpec.field),
      ('channel-mutes', 'muted'),
    );
    expect(
      (stars.channelStarsSpec.dTag, stars.channelStarsSpec.field),
      ('channel-stars', 'starred'),
    );
  });

  test('a store serializes under its own field and ignores other flags', () {
    const store = mutes.ChannelMuteStore(
      channels: {'a': mutes.ChannelMuteEntry(muted: true, updatedAt: 5)},
    );
    expect(store.toJson(), {
      'version': 1,
      'channels': {
        'a': {'muted': true, 'updatedAt': 5},
      },
    });
    final parsed = stars.ChannelStarStore.fromJson(store.toJson());
    expect(parsed.channels, isEmpty);
  });
}
