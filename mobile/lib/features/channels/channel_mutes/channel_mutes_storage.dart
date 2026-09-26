import 'package:shared_preferences/shared_preferences.dart';

import '../channel_flags/channel_flag_store.dart';

String channelMutesKey(String pubkey) => channelMutesSpec.storageKey(pubkey);

class ChannelMuteEntry extends ChannelFlagEntry {
  const ChannelMuteEntry({required bool muted, required super.updatedAt})
    : super(value: muted);

  bool get muted => value;

  Map<String, dynamic> toJson() => {'muted': muted, 'updatedAt': updatedAt};

  factory ChannelMuteEntry.fromJson(Map<String, dynamic> json) =>
      ChannelMuteEntry(
        muted: json['muted'] as bool,
        updatedAt: json['updatedAt'] as int,
      );
}

class ChannelMuteStore extends ChannelFlagStore<ChannelMuteEntry> {
  const ChannelMuteStore({super.version, super.channels});

  Map<String, dynamic> toJson() => toJsonWithField('muted');

  factory ChannelMuteStore.fromJson(Map<String, dynamic> json) =>
      channelMutesSpec.fromJson(json);
}

final channelMutesSpec = ChannelFlagSpec<ChannelMuteEntry, ChannelMuteStore>(
  field: 'muted',
  storageKeyPrefix: 'buzz.channel-mutes.v1',
  dTag: 'channel-mutes',
  logName: 'ChannelMutesManager',
  entry: (value, updatedAt) =>
      ChannelMuteEntry(muted: value, updatedAt: updatedAt),
  store: (channels) => ChannelMuteStore(channels: channels),
);

ChannelMuteStore mergeStores(ChannelMuteStore local, ChannelMuteStore remote) =>
    channelMutesSpec.merge(local, remote);

class ChannelMutesStorage
    extends ChannelFlagStorage<ChannelMuteEntry, ChannelMuteStore> {
  ChannelMutesStorage(SharedPreferences prefs) : super(channelMutesSpec, prefs);
}
