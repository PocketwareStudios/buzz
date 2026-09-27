import 'package:hooks_riverpod/hooks_riverpod.dart';

import '../channel_flags/channel_flag_notifier.dart';
import '../channel_flags/channel_flag_store.dart';
import 'channel_mutes_storage.dart';

class ChannelMutesState extends ChannelFlagState<ChannelMuteStore> {
  const ChannelMutesState({
    super.isReady = false,
    super.store = const ChannelMuteStore(),
    super.version = 0,
  });
}

class ChannelMutesNotifier
    extends
        ChannelFlagNotifier<
          ChannelMuteEntry,
          ChannelMuteStore,
          ChannelMutesState
        > {
  @override
  ChannelFlagSpec<ChannelMuteEntry, ChannelMuteStore> get spec =>
      channelMutesSpec;

  @override
  ChannelMutesState get emptyState => const ChannelMutesState();

  @override
  ChannelMutesState stateFor({
    required bool isReady,
    required ChannelMuteStore store,
    required int version,
  }) => ChannelMutesState(isReady: isReady, store: store, version: version);

  void muteChannel(String channelId) => setFlag(channelId, true);

  void unmuteChannel(String channelId) => setFlag(channelId, false);
}

final channelMutesProvider =
    NotifierProvider<ChannelMutesNotifier, ChannelMutesState>(
      ChannelMutesNotifier.new,
    );
