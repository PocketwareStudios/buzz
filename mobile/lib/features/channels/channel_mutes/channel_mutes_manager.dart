import 'package:flutter/foundation.dart';

import '../channel_flags/channel_flag_manager.dart';
import 'channel_mutes_storage.dart';

class ChannelMutesCrypto extends ChannelFlagCrypto {
  ChannelMutesCrypto(super.nsec, super.pubkey);
}

class ChannelMutesManager
    extends ChannelFlagManager<ChannelMuteEntry, ChannelMuteStore> {
  ChannelMutesManager({
    required super.pubkey,
    required super.prefs,
    required super.crypto,
    required super.relaySession,
    required super.signedEventRelay,
    required super.remoteEnabled,
    required super.onChanged,
    @visibleForTesting super.startupRetryBaseDelay,
  }) : super(spec: channelMutesSpec);

  void muteChannel(String channelId) => setFlag(channelId, true);

  void unmuteChannel(String channelId) => setFlag(channelId, false);
}
