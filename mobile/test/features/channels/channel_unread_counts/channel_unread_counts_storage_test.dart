import 'package:buzz/features/channels/channel_unread_counts/channel_unread_counts_storage.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  // Persisted on every device and on the relay, and shared with desktop.
  test('unread-count settings keep their storage key and wire format', () {
    expect(
      channelUnreadCountsSpec.storageKey('pk'),
      'buzz.channel-unread-counts.v1:pk',
    );
    expect(
      (channelUnreadCountsSpec.dTag, channelUnreadCountsSpec.field),
      ('channel-unread-counts', 'enabled'),
    );
  });

  group('channelRowUnreadCount', () {
    const counts = {'news': 12, 'quiet': 0};

    test('a channel that did not opt in shows no number', () {
      expect(
        channelRowUnreadCount(
          'news',
          unreadCountChannelIds: const {},
          mutedChannelIds: const {},
          unreadCounts: counts,
        ),
        isNull,
      );
    });

    test('an opted-in channel shows its unread count', () {
      expect(
        channelRowUnreadCount(
          'news',
          unreadCountChannelIds: const {'news'},
          mutedChannelIds: const {},
          unreadCounts: counts,
        ),
        12,
      );
    });

    test('nothing unread shows no number', () {
      for (final id in ['quiet', 'unknown']) {
        expect(
          channelRowUnreadCount(
            id,
            unreadCountChannelIds: {id},
            mutedChannelIds: const {},
            unreadCounts: counts,
          ),
          isNull,
          reason: id,
        );
      }
    });

    test('mute wins over an opted-in count', () {
      expect(
        channelRowUnreadCount(
          'news',
          unreadCountChannelIds: const {'news'},
          mutedChannelIds: const {'news'},
          unreadCounts: counts,
        ),
        isNull,
      );
    });
  });
}
