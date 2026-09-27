import 'package:hooks_riverpod/hooks_riverpod.dart';

import '../channel_flags/channel_flag_notifier.dart';
import '../channel_flags/channel_flag_store.dart';
import 'channel_stars_storage.dart';

class ChannelStarsState extends ChannelFlagState<ChannelStarStore> {
  const ChannelStarsState({
    super.isReady = false,
    super.store = const ChannelStarStore(),
    super.version = 0,
  });
}

class ChannelStarsNotifier
    extends
        ChannelFlagNotifier<
          ChannelStarEntry,
          ChannelStarStore,
          ChannelStarsState
        > {
  @override
  ChannelFlagSpec<ChannelStarEntry, ChannelStarStore> get spec =>
      channelStarsSpec;

  @override
  ChannelStarsState get emptyState => const ChannelStarsState();

  @override
  ChannelStarsState stateFor({
    required bool isReady,
    required ChannelStarStore store,
    required int version,
  }) => ChannelStarsState(isReady: isReady, store: store, version: version);

  void starChannel(String channelId) => setFlag(channelId, true);

  void unstarChannel(String channelId) => setFlag(channelId, false);
}

final channelStarsProvider =
    NotifierProvider<ChannelStarsNotifier, ChannelStarsState>(
      ChannelStarsNotifier.new,
    );
