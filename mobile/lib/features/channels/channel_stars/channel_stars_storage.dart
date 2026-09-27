import 'package:shared_preferences/shared_preferences.dart';

import '../channel_flags/channel_flag_store.dart';

String channelStarsKey(String pubkey) => channelStarsSpec.storageKey(pubkey);

class ChannelStarEntry extends ChannelFlagEntry {
  const ChannelStarEntry({required bool starred, required super.updatedAt})
    : super(value: starred);

  bool get starred => value;

  Map<String, dynamic> toJson() => {'starred': starred, 'updatedAt': updatedAt};

  factory ChannelStarEntry.fromJson(Map<String, dynamic> json) =>
      ChannelStarEntry(
        starred: json['starred'] as bool,
        updatedAt: json['updatedAt'] as int,
      );
}

class ChannelStarStore extends ChannelFlagStore<ChannelStarEntry> {
  const ChannelStarStore({super.version, super.channels});

  Map<String, dynamic> toJson() => toJsonWithField('starred');

  factory ChannelStarStore.fromJson(Map<String, dynamic> json) =>
      channelStarsSpec.fromJson(json);
}

final channelStarsSpec = ChannelFlagSpec<ChannelStarEntry, ChannelStarStore>(
  field: 'starred',
  storageKeyPrefix: 'buzz.channel-stars.v1',
  dTag: 'channel-stars',
  logName: 'ChannelStarsManager',
  entry: (value, updatedAt) =>
      ChannelStarEntry(starred: value, updatedAt: updatedAt),
  store: (channels) => ChannelStarStore(channels: channels),
);

ChannelStarStore mergeStores(ChannelStarStore local, ChannelStarStore remote) =>
    channelStarsSpec.merge(local, remote);

class ChannelStarsStorage
    extends ChannelFlagStorage<ChannelStarEntry, ChannelStarStore> {
  ChannelStarsStorage(SharedPreferences prefs) : super(channelStarsSpec, prefs);
}
