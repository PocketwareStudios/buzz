import 'package:flutter/foundation.dart';

import '../channel_flags/channel_flag_manager.dart';
import 'channel_stars_storage.dart';

class ChannelStarsCrypto extends ChannelFlagCrypto {
  ChannelStarsCrypto(super.nsec, super.pubkey);
}

class ChannelStarsManager
    extends ChannelFlagManager<ChannelStarEntry, ChannelStarStore> {
  ChannelStarsManager({
    required super.pubkey,
    required super.prefs,
    required super.crypto,
    required super.relaySession,
    required super.signedEventRelay,
    required super.remoteEnabled,
    required super.onChanged,
    @visibleForTesting super.startupRetryBaseDelay,
  }) : super(spec: channelStarsSpec);

  void starChannel(String channelId) => setFlag(channelId, true);

  void unstarChannel(String channelId) => setFlag(channelId, false);
}
