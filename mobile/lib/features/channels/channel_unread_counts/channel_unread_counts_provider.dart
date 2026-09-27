import 'package:hooks_riverpod/hooks_riverpod.dart';

import '../channel_flags/channel_flag_notifier.dart';
import '../channel_flags/channel_flag_store.dart';
import 'channel_unread_counts_storage.dart';

class ChannelUnreadCountsState
    extends ChannelFlagState<ChannelUnreadCountStore> {
  const ChannelUnreadCountsState({
    super.isReady = false,
    super.store = const ChannelUnreadCountStore(),
    super.version = 0,
  });
}

class ChannelUnreadCountsNotifier
    extends
        ChannelFlagNotifier<
          ChannelUnreadCountEntry,
          ChannelUnreadCountStore,
          ChannelUnreadCountsState
        > {
  @override
  ChannelFlagSpec<ChannelUnreadCountEntry, ChannelUnreadCountStore> get spec =>
      channelUnreadCountsSpec;

  @override
  ChannelUnreadCountsState get emptyState => const ChannelUnreadCountsState();

  @override
  ChannelUnreadCountsState stateFor({
    required bool isReady,
    required ChannelUnreadCountStore store,
    required int version,
  }) => ChannelUnreadCountsState(
    isReady: isReady,
    store: store,
    version: version,
  );

  void showUnreadCount(String channelId) => setFlag(channelId, true);

  void hideUnreadCount(String channelId) => setFlag(channelId, false);
}

final channelUnreadCountsProvider =
    NotifierProvider<ChannelUnreadCountsNotifier, ChannelUnreadCountsState>(
      ChannelUnreadCountsNotifier.new,
    );
